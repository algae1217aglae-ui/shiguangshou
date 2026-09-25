import { acquireImageRetentionClaim } from '../image-retention-fence.mjs';

const runtimeRoot = process.argv[2];
if (!runtimeRoot || typeof process.send !== 'function') process.exit(2);

const claim = await acquireImageRetentionClaim({ runtimeRoot, relativePath: 'inbox/synthetic.jpg', kind: 'test-writer' });
process.send('ready');
process.once('message', async message => {
  if (message !== 'release') return;
  await claim.release();
  process.exit(0);
});
