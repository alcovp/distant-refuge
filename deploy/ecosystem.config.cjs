const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'distant-refuge',
      cwd: path.resolve(__dirname, '..'),
      script: 'server.mjs',
      interpreter: 'node',
      node_args: '--env-file=.env',
      instances: 1,
      exec_mode: 'fork',
      restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
