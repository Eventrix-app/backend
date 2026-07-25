import { Injectable, NotFoundException, Logger, OnModuleInit, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EventCategory } from '../entities/category.entity';
import { Event } from '../entities/event.entity';
import { BulkCreateCategoriesDto, CreateCategoryDto } from './category.dto';
import { PartialType } from '@nestjs/mapped-types';
import { CacheService } from '../common/cache/cache.service';

export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {}

const CATEGORIES_CACHE_KEY = 'categories:all';
const CATEGORIES_CACHE_TTL_SECONDS = 300;

@Injectable()
export class CategoryService implements OnModuleInit {
  private readonly logger = new Logger(CategoryService.name);

  constructor(
    @InjectRepository(EventCategory)
    private readonly categoryRepo: Repository<EventCategory>,
    @InjectRepository(Event)
    private readonly eventRepo: Repository<Event>,
    private readonly cache: CacheService,
  ) {}

  async onModuleInit() {
    // Seed default categories if none exist
    const count = await this.categoryRepo.count();
    if (count === 0) {
      const defaults = [
        { name: 'Music', description: 'Live music, concerts, and festivals' },
        { name: 'Tech', description: 'Tech conferences, workshops, and meetups' },
        { name: 'Sports', description: 'Sports events and competitions' },
        { name: 'Health', description: 'Health, wellness, and fitness events' },
        { name: 'Business', description: 'Business networking and conferences' },
        { name: 'Education', description: 'Workshops, seminars, and courses' },
        { name: 'Food', description: 'Food festivals and culinary events' },
        { name: 'Art', description: 'Art exhibitions and cultural events' },
      ];
      for (const data of defaults) {
        const cat = this.categoryRepo.create(data);
        await this.categoryRepo.save(cat);
        this.logger.log(`Seeded default category: ${data.name}`);
      }
    }
  }

  async create(dto: CreateCategoryDto): Promise<EventCategory> {
    const category = this.categoryRepo.create(dto);
    const saved = await this.categoryRepo.save(category);
    await this.cache.del(CATEGORIES_CACHE_KEY);
    return saved;
  }

  async bulkCreate(dto: BulkCreateCategoriesDto): Promise<EventCategory[]> {
    const normalizedCategories = dto.categories.map((category) => ({
      ...category,
      name: category.name.trim(),
    }));

    const duplicateNames = normalizedCategories
      .map((category) => category.name)
      .filter((name, index, names) => names.indexOf(name) !== index);

    if (duplicateNames.length > 0) {
      throw new BadRequestException(
        `Duplicate category names in request: ${Array.from(new Set(duplicateNames)).join(', ')}`,
      );
    }

    const existingCategories = await this.categoryRepo.find({
      select: ['name'],
      where: {
        name: In(normalizedCategories.map((category) => category.name)),
      },
    });

    if (existingCategories.length > 0) {
      throw new ConflictException(
        `Category names already exist: ${existingCategories.map((category) => category.name).join(', ')}`,
      );
    }

    const saved = await this.categoryRepo.manager.transaction(async (manager) => {
      const categories = manager.create(EventCategory, normalizedCategories);
      return await manager.save(EventCategory, categories);
    });
    await this.cache.del(CATEGORIES_CACHE_KEY);
    return saved;
  }

  async findAll(): Promise<EventCategory[]> {
    const cached = await this.cache.get<EventCategory[]>(CATEGORIES_CACHE_KEY);
    if (cached) return cached;
    const categories = await this.categoryRepo.find();
    await this.cache.set(CATEGORIES_CACHE_KEY, categories, CATEGORIES_CACHE_TTL_SECONDS);
    return categories;
  }

  async findOne(id: string): Promise<EventCategory> {
    const cat = await this.categoryRepo.findOne({ where: { id } });
    if (!cat) throw new NotFoundException(`Category ${id} not found`);
    return cat;
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<EventCategory> {
    const cat = await this.findOne(id);
    Object.assign(cat, dto);
    const saved = await this.categoryRepo.save(cat);
    await this.cache.del(CATEGORIES_CACHE_KEY);
    return saved;
  }

  async remove(id: string): Promise<void> {
    const cat = await this.findOne(id);

    // events.category_id is NOT NULL with no ON DELETE clause, so removing a category
    // still referenced by an event would otherwise fail with a raw FK-violation
    // QueryFailedError — check explicitly and return a clean 409 instead.
    const eventCount = await this.eventRepo.count({ where: { categoryId: id } });
    if (eventCount > 0) {
      throw new ConflictException(
        `Cannot delete category "${cat.name}": ${eventCount} event(s) still use it`,
      );
    }

    await this.categoryRepo.remove(cat);
    await this.cache.del(CATEGORIES_CACHE_KEY);
  }
}
