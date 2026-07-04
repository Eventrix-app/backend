import { Injectable } from '@nestjs/common';
import { readdir, readFile } from 'fs/promises';
import { join, extname, basename } from 'path';

export interface ComponentInfo {
  name: string;
  path: string;
  type: 'component' | 'screen' | 'navigation';
  category: string;
  content: string;
  imports: string[];
  exports: string[];
}

@Injectable()
export class PreviewService {
  private readonly frontendPath = join(
    __dirname,
    '..',
    '..',
    '..',
    'Frontend',
    'src',
  );

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async getAllComponents(): Promise<ComponentInfo[]> {
    const components: ComponentInfo[] = [];

    // Scan all relevant directories
    const directories = ['components', 'screens', 'navigation'];

    for (const dir of directories) {
      const dirPath = join(this.frontendPath, dir);
      try {
        await this.scanDirectory(dirPath, dir, components);
      } catch (error) {
        console.warn(
          `Could not scan directory ${dir}:`,
          this.getErrorMessage(error),
        );
      }
    }

    return components;
  }

  private async scanDirectory(
    dirPath: string,
    type: string,
    components: ComponentInfo[],
  ): Promise<void> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);

        if (entry.isDirectory()) {
          await this.scanDirectory(fullPath, type, components);
        } else if (entry.isFile() && this.isTsxFile(entry.name)) {
          const componentInfo = await this.parseComponentFile(fullPath, type);
          if (componentInfo) {
            components.push(componentInfo);
          }
        }
      }
    } catch (error) {
      console.warn(
        `Error scanning directory ${dirPath}:`,
        this.getErrorMessage(error),
      );
    }
  }

  private isTsxFile(filename: string): boolean {
    return extname(filename) === '.tsx';
  }

  private async parseComponentFile(
    filePath: string,
    type: string,
  ): Promise<ComponentInfo | null> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const relativePath = filePath.replace(this.frontendPath, '');
      const fileName = basename(filePath, '.tsx');

      // Extract imports
      const importRegex = /import\s+.*?from\s+['"](.+?)['"]/g;
      const imports: string[] = [];
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        imports.push(match[1]);
      }

      // Extract exports (default and named)
      const exports: string[] = [];
      const defaultExportRegex = /export\s+default\s+(\w+)/;
      const namedExportRegex = /export\s+(?:const|function|class)\s+(\w+)/g;

      const defaultMatch = content.match(defaultExportRegex);
      if (defaultMatch) {
        exports.push(defaultMatch[1]);
      }

      while ((match = namedExportRegex.exec(content)) !== null) {
        exports.push(match[1]);
      }

      // Determine category from path
      const pathParts = relativePath.split('\\');
      const category = pathParts.length > 2 ? pathParts[1] : 'root';

      return {
        name: fileName,
        path: relativePath,
        type: type as 'component' | 'screen' | 'navigation',
        category,
        content,
        imports,
        exports,
      };
    } catch (error) {
      console.warn(
        `Error parsing file ${filePath}:`,
        this.getErrorMessage(error),
      );
      return null;
    }
  }
}
