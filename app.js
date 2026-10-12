// Entry file for hosts that start a Node.js app from the repository root (for example Hostinger's
// Node.js web apps, whose default entry file is app.js). Starts the portal: API and built web pages.
import('./server/src/index.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
