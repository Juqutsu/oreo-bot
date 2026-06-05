const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Load .env if it exists
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf8');
  for (const line of envConfig.split('\n')) {
    const parts = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (parts) {
      const key = parts[1];
      let val = parts[2] || '';
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

async function run() {
  console.log('🚀 Starte Oreo Smoke-Tests...\n');

  // Initialize DB schema if config is present
  const hasDbConfig = process.env.MYSQL_HOST && process.env.MYSQL_USER && process.env.MYSQL_DATABASE;
  if (hasDbConfig) {
    console.log('🗄️ Datenbank-Konfiguration gefunden. Stelle Schema sicher...');
    try {
      const { ensureSchema } = require('../src/schema');
      await ensureSchema();
      console.log('✅ Schema-Setup erfolgreich sichergestellt.\n');
    } catch (err) {
      console.error('❌ Schema-Setup fehlgeschlagen:', err.message);
      console.error('Die Tests werden trotzdem gestartet, könnten aber fehlschlagen.\n');
    }
  } else {
    console.warn('⚠️ Keine Datenbank-Konfiguration gefunden. Schema-Setup übersprungen.\n');
  }

  const smokeDir = path.join(__dirname, 'smoke');
  let files;
  try {
    files = fs.readdirSync(smokeDir).filter(f => f.endsWith('.js'));
  } catch (err) {
    console.error(`Fehler beim Lesen des Verzeichnisses ${smokeDir}:`, err.message);
    process.exit(1);
  }

  let failed = false;
  const failedTests = [];

  for (const file of files) {
    const filePath = path.join(smokeDir, file);
    console.log(`--------------------------------------------------`);
    console.log(`🏃 Running: ${file}`);
    console.log(`--------------------------------------------------`);
    
    // Pass the process.env containing the loaded .env to child processes
    const result = spawnSync('node', [filePath], { 
      stdio: 'inherit',
      env: process.env 
    });
    
    if (result.status !== 0) {
      console.error(`\n❌ ${file} fehlgeschlagen mit Exit-Code ${result.status}\n`);
      failed = true;
      failedTests.push(file);
    } else {
      console.log(`\n✅ ${file} erfolgreich durchgelaufen\n`);
    }
  }

  console.log(`==================================================`);
  if (failed) {
    console.error(`❌ Einige Tests sind fehlgeschlagen:\n- ${failedTests.join('\n- ')}`);
    process.exit(1);
  } else {
    console.log(`🎉 Alle ${files.length} Smoke-Tests erfolgreich bestanden!`);
    process.exit(0);
  }
}

run().catch(err => {
  console.error('Unerwarteter Fehler im Test-Runner:', err);
  process.exit(1);
});
