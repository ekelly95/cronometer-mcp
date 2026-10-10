#!/usr/bin/env node
// Prints the scrypt hash of the owner password read from standard input.
//
// Standard input rather than an argument: an argument is visible to every other
// process on the machine for as long as this one runs, and lands in shell history.
// The setup script pipes the password in and stores only what this prints.

import { hashPassword } from '../../dist/http/password.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');

try {
  process.stdout.write(`${await hashPassword(password)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Could not hash the password.'}\n`);
  process.exitCode = 1;
}
