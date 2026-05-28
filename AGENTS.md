# Agent Guidelines

## Commands
- **Install**: `npm install`
- **Type check**: `npm run typecheck`
- **Test**: `npm test`
- **Test manually**: `node --import tsx -e "import { MemoryPlugin } from './index.ts'; ..."`

## Code Style
- **Runtime**: Node.js (use `child_process.spawnSync`, avoid Bun-specific APIs)
- **Imports**: Use `import type` for type-only imports (`verbatimModuleSyntax`)
- **Types**: Strict mode enabled, handle `undefined` from indexed access (`noUncheckedIndexedAccess`)
- **Naming**: camelCase for functions/variables, PascalCase for types/interfaces
- **Exports**: Re-export public API from `index.ts`, implementation in `src/`

## Plugin Structure
- Tools use `@opencode-ai/plugin` `tool()` helper with Zod-like schema (`tool.schema`)
- Plugin exports async function returning `{ tool: { ... } }`
- Memories stored on `refs/memory/agent` git branch as logfmt files
