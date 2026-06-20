#!/usr/bin/env node
/* rotate-account-key.mjs <login>
 * Issues a NEW account key for an existing passwordless account (owner recovery).
 * Only rewrites that one user's accountKeyHash. Run while skill-api is STOPPED
 * (db.js caches in memory and would otherwise clobber the edit on next persist).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const FILE = (process.env.DATA_DIR || '/var/lib/skill-api') + '/platform.json';
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const login = process.argv[2];
if (!login) { console.error('usage: rotate-account-key.mjs <login>'); process.exit(1); }

const db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const u = Object.values(db.users || {}).find(x => x.login === login);
if (!u) { console.error('NO_USER: no account with login=' + login); process.exit(2); }

const key = 'xn_acct_' + crypto.randomBytes(20).toString('hex');
u.accountKeyHash = sha256(key);

const TMP = FILE + '.tmp';
fs.writeFileSync(TMP, JSON.stringify(db));
fs.renameSync(TMP, FILE);

const skills = Object.values(db.skills || {}).filter(s => s.ownerId === u.id).length;
console.log(JSON.stringify({ login: u.login, id: u.id, skills, newKey: key }));
