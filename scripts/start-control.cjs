// Validate production environment before the standalone HTTP listener starts.
process.env.NODE_ENV = 'production'
require('./control-config.cjs').loadEnv()
require('./server.js')
