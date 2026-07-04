import { Injectable, NotFoundException, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventCategory } from '../entities/category.entity';
import { CreateCategoryDto } from './category.dto';
import { PartialType } from '@nestjs/mapped-types';

export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {}

@Injectable()
export class CategoryService implements OnModuleInit {
  private readonly logger = new Logger(CategoryService.name);

  constructor(
    @InjectRepository(EventCategory)
    private readonly categoryRepo: Repository<EventCategory>,
  ) {}

  async onModuleInit() {
    // Seed default categories if none exist
    const count = await this.categoryRepo.count();
    if (count === 0) {
      const defaults = [
        { name: 'Music', emoji: '🎵', colorHex: '#FF3366', description: 'Live music, concerts, and festivals' },
        { name: 'Tech', emoji: '💻', colorHex: '#3B82F6', description: 'Tech conferences, workshops, and meetups' },
        { name: 'Sports', emoji: '⚽', colorHex: '#10B981', description: 'Sports events and competitions' },
        { name: 'Health', emoji: '🧘', colorHex: '#8B5CF6', description: 'Health, wellness, and fitness events' },
        { name: 'Business', emoji: '💼', colorHex: '#F59E0B', description: 'Business networking and conferences' },
        { name: 'Education', emoji: '📚', colorHex: '#EC4899', description: 'Workshops, seminars, and courses' },
        { name: 'Food', emoji: '🍔', colorHex: '#FF6B6B', description: 'Food festivals and culinary events' },
        { name: 'Art', emoji: '🎨', colorHex: '#9B59B6', description: 'Art exhibitions and cultural events' },
      ];
      for (const data of defaults) {
        const cat = this.categoryRepo.create(data);
        await this.categoryRepo.save(cat);
        this.logger.log(`Seeded default category: ${data.name} ${data.emoji}`);
      }
    }
  }

  async create(dto: CreateCategoryDto): Promise<EventCategory> {
    const category = this.categoryRepo.create(dto);
    return await this.categoryRepo.save(category);
  }

  async findAll(): Promise<EventCategory[]> {
    return await this.categoryRepo.find();
  }

  async findOne(id: string): Promise<EventCategory> {
    const cat = await this.categoryRepo.findOne({ where: { id } });
    if (!cat) throw new NotFoundException(`Category ${id} not found`);
    return cat;
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<EventCategory> {
    const cat = await this.findOne(id);
    Object.assign(cat, dto);
    return await this.categoryRepo.save(cat);
  }

  async remove(id: string): Promise<void> {
    const cat = await this.findOne(id);
    await this.categoryRepo.remove(cat);
  }
}
