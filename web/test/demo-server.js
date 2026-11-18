'use strict';

const { fixture } = require('./fixture');

fixture({ port: Number(process.env.PXDER_TEST_PORT || 18781), withToken: true }).then(({ app, clean }) => {
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, async () => { await app.close(); await clean(); });
  console.log('Local WebUI test server is ready with fake Pixiv responses.');
}).catch(error => { console.error(error); process.exitCode = 1; });
