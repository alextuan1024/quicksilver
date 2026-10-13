import { readFileSync, readdirSync } from 'node:fs';
const files = readdirSync('.').filter(name => /\.(mjs|json|md|yaml)$/.test(name));
const patterns = [/gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /sk-(?:proj-)?[A-Za-z0-9_-]{30,}/,
  /(?:QUICKSILVER_API_KEY|SPECTRUM_PROJECT_SECRET)\s*[:=]\s*["'][^"']{20,}["']/];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (patterns.some(pattern => pattern.test(text))) throw new Error(`Potential secret in ${file}; inspect locally`);
}
console.log(`Secret-pattern scan passed for ${files.length} source files. Test signing values are public fixtures.`);
