#!/usr/bin/env node
// Seed default admin user if no users exist
// Run: node scripts/seed-admin.js
// Also called automatically from app.js on startup

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

async function seedAdmin(mongoUri) {
  const uri = mongoUri || process.env.MONGODB_URI || 'mongodb://localhost:27017/shadowpbx';

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri);
  }

  const { User } = require('../src/models');
  const count = await User.countDocuments();
  if (count > 0) {
    console.log(`Users exist (${count}), skipping seed.`);
    return false;
  }

  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin';
  const hash = await bcrypt.hash(adminPass, 10);

  await User.create({
    username: adminUser,
    password: hash,
    role: 'admin',
    name: 'Administrator',
    enabled: true
  });

  console.log(`Default admin user "${adminUser}" created.`);
  return true;
}

// Run directly
if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  seedAdmin().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = seedAdmin;
