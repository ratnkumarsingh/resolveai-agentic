import { loadConfig } from "../config.js";
import { openDb } from "./index.js";
import { seedDemoData } from "./seed.js";

const config = loadConfig();
const db = openDb(config.dbPath);
seedDemoData(db);
db.close();
console.log(`Seeded demo dataset into ${config.dbPath}`);
