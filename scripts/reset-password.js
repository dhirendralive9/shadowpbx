#!/usr/bin/env node
// ShadowPBX - Reset admin password
// Usage: node scripts/reset-password.js [new-password]
// If no password provided, generates a random one.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV_FILE = path.join(__dirname, '..', '.env');

function generatePassword(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pass = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) {
    pass += chars[bytes[i] % chars.length];
  }
  return pass;
}

function updateEnv(key, value) {
  let content = '';
  try { content = fs.readFileSync(ENV_FILE, 'utf8'); } catch (e) {}

  const regex = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;

  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content = content.trimEnd() + '\n' + line + '\n';
  }

  fs.writeFileSync(ENV_FILE, content);
}

// Main
const newPass = process.argv[2] || generatePassword(16);

updateEnv('ADMIN_PASSWORD', newPass);
updateEnv('ADMIN_USER', process.env.ADMIN_USER || 'admin');

console.log('');
console.log('============================================');
console.log('  ShadowPBX - Admin Password Reset');
console.log('============================================');
console.log('');
console.log('  Username: admin');
console.log(`  Password: ${newPass}`);
console.log('');
console.log('  GUI:  http://your-server:3000/');
console.log('');
console.log('  Restart ShadowPBX to apply:');
console.log('    systemctl restart shadowpbx');
console.log('');
console.log('============================================');
