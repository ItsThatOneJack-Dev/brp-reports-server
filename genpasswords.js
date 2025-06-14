#!/usr/bin/env node

const bcrypt = require('bcrypt');
const readline = require('readline');

// Configuration
const SALT_ROUNDS = 12; // ~100ms/password

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function generateHashes() {
  const hashes = [];
  
  console.log('Enter passwords one at a time. Press Enter with an empty password to finish.\n');
  
  while (true) {
    const password = await new Promise((resolve) => {
      rl.question('Enter password: ', (answer) => {
        resolve(answer);
      });
    });
    
    // Empty password signals end of input
    if (password === '') {
      break;
    }
    
    try {
      console.log('Hashing password...');
      const hash = await bcrypt.hash(password, SALT_ROUNDS);
      hashes.push(hash);
      console.log('✓ Password hashed successfully\n');
    } catch (error) {
      console.error(`Error hashing password: ${error.message}\n`);
    }
  }
  
  rl.close();
  
  if (hashes.length === 0) {
    console.log('No passwords were provided.');
    return;
  }
  
  // Generate the LOGIN_HASHES string
  const loginHashesValue = hashes.join('; ');
  
  console.log('\n' + '='.repeat(50));
  console.log('Set your LOGIN_HASHES environment variable to:');
  console.log('='.repeat(50));
  console.log(loginHashesValue);
  console.log('\n' + '='.repeat(50));
  console.log('Example usage:');
  console.log(`export LOGIN_HASHES="${loginHashesValue}"`);
  console.log('='.repeat(50));
}

// Run the script
generateHashes().catch((error) => {
  console.error('Script error:', error);
  process.exit(1);
});
