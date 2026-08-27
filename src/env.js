// Loads .env from an absolute path derived from this file's location,
// rather than relying on process.cwd(). This matters because MCP clients
// (like Claude Desktop) may spawn this process without setting the working
// directory to the project folder, which would otherwise leave
// SUPABASE_URL/SUPABASE_SERVICE_KEY undefined.
//
// This must be its own module and must be the FIRST import in index.js.
// ES modules evaluate all `import` statements (in declaration order) before
// any of the importing file's own top-level code runs — so if this logic
// lived directly in index.js below other imports, those other imports
// (which transitively read process.env in supabaseClient.js) would already
// have executed before the env vars were loaded.
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });
