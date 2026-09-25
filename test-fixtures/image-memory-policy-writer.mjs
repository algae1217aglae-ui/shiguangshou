import { initializeImageMemoryPolicyAsync, revokeImageMemoryAsync } from '../image-memory-policy.mjs';

const [policyPath, relativePath, revokedAt] = process.argv.slice(2);
process.stdout.write('ready\n');
const result = relativePath === '--initialize'
  ? await initializeImageMemoryPolicyAsync(policyPath, { lockTimeoutMs: 2000 })
  : await revokeImageMemoryAsync({ policyPath, relativePaths: [relativePath], revokedAt: Number(revokedAt), lockTimeoutMs: 2000 });
process.stdout.write(`${JSON.stringify(result)}\n`);
