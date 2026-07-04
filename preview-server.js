const express = require('express');
const cors = require('cors');
const { readdir, readFile } = require('fs/promises');
const { join, extname, basename } = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const frontendPath = join(__dirname, '..', 'Frontend', 'src');

// Middleware
app.use(cors());
app.use(express.json());

// Component scanning functions
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

// Routes
app.get('/preview/api', async (req, res) => {
  try {
    const components = await scanComponents();
    res.json(components);
  } catch (error) {
    console.error('Error scanning components:', error);
    res.status(500).json({ error: 'Failed to scan components' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`Preview server running on http://localhost:${PORT}`);
  console.log(`API endpoint: http://localhost:${PORT}/preview/api`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

module.exports = app;
