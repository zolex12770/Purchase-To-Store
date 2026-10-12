module.exports = {
  apps: [
    {
      name: 'zolex-purchase-backend',
      script: './dist/index.js',
      cwd: 'C:/Users/Saurabh.kumar/Desktop/Purchase Module/backend',
      env: {
        NODE_ENV: 'production',
        PORT: '4001',
      },
    },
    {
      name: 'zolex-purchase-frontend',
      script: './node_modules/vite/bin/vite.js',
      interpreter: 'node',
      args: 'preview --port 8080 --host 0.0.0.0',
      cwd: 'C:/Users/Saurabh.kumar/Desktop/Purchase Module/frontend',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
