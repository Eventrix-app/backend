const { readdir, readFile } = require('fs/promises');
const { join, extname, basename } = require('path');

const frontendPath = join(__dirname, '..', 'Frontend', 'src');

async function scanComponents() {
  const components = [];
  const directories = ['components', 'screens', 'navigation'];
  
  for (const dir of directories) {
    const dirPath = join(frontendPath, dir);
    try {
      await scanDirectory(dirPath, dir, components);
    } catch (error) {
      console.warn(`Could not scan directory ${dir}:`, error.message);
    }
  }
  
  return components;
}

async function scanDirectory(dirPath, type, components) {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        await scanDirectory(fullPath, type, components);
      } else if (entry.isFile() && isTsxFile(entry.name)) {
        const componentInfo = await parseComponentFile(fullPath, type);
        if (componentInfo) {
          components.push(componentInfo);
        }
      }
    }
  } catch (error) {
    console.warn(`Error scanning directory ${dirPath}:`, error.message);
  }
}

function isTsxFile(filename) {
  return extname(filename) === '.tsx';
}

async function parseComponentFile(filePath, type) {
  try {
    const content = await readFile(filePath, 'utf-8');
    const relativePath = filePath.replace(frontendPath, '');
    const fileName = basename(filePath, '.tsx');
    
    const importRegex = /import\s+.*?from\s+['"](.+?)['"]/g;
    const imports = [];
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }

    const exports = [];
    const defaultExportRegex = /export\s+default\s+(\w+)/;
    const namedExportRegex = /export\s+(?:const|function|class)\s+(\w+)/g;
    
    const defaultMatch = content.match(defaultExportRegex);
    if (defaultMatch) {
      exports.push(defaultMatch[1]);
    }
    
    while ((match = namedExportRegex.exec(content)) !== null) {
      exports.push(match[1]);
    }

    const pathParts = relativePath.split('\\');
    const category = pathParts.length > 2 ? pathParts[1] : 'root';

    return {
      name: fileName,
      path: relativePath,
      type,
      category,
      content,
      imports,
      exports
    };
  } catch (error) {
    console.warn(`Error parsing file ${filePath}:`, error.message);
    return null;
  }
}

async function main() {
  console.log('Scanning components...');
  const components = await scanComponents();
  
  console.log(`Found ${components.length} components:`);
  components.forEach((comp, index) => {
    console.log(`${index + 1}. ${comp.name} (${comp.type}) - ${comp.category}`);
    console.log(`   Path: ${comp.path}`);
    console.log(`   Exports: ${comp.exports.join(', ')}`);
    console.log(`   Imports: ${comp.imports.length} files`);
    console.log('');
  });
  
  // Save to JSON for testing
  const fs = require('fs');
  fs.writeFileSync('components.json', JSON.stringify(components, null, 2));
  console.log('Components saved to components.json');
}

main().catch(console.error);
