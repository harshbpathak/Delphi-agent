// pm2 process file: runs the trading agent + python flow service 24/7
// Usage: pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
    apps: [
        {
            name: 'mha-agent',
            script: 'dist/index.js',
            cwd: __dirname,
            restart_delay: 10000,
            max_restarts: 50,
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            out_file: 'logs/agent.out.log',
            error_file: 'logs/agent.err.log',
        },
        {
            name: 'mha-python',
            script: 'python3',
            args: '-m uvicorn main:app --host 127.0.0.1 --port 8000',
            cwd: `${__dirname}/python`,
            interpreter: 'none',
            restart_delay: 10000,
            out_file: '../logs/python.out.log',
            error_file: '../logs/python.err.log',
        },
    ],
};
