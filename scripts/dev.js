const { spawn, exec } = require('child_process');
const net = require('net');
const path = require('path');

const PORT = process.env.PORT || 4040;

// Check if port is in use
function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));  // Port in use
    server.once('listening', () => {
      server.close();
      resolve(false);  // Port available
    });
    server.listen(port);
  });
}

// Kill process using port (Windows/Unix compatible)
function killPort(port) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /F /PID %a`,
        { shell: 'cmd.exe' }, () => resolve());
    } else {
      exec(`lsof -ti:${port} | xargs kill -9 2>/dev/null`, () => resolve());
    }
  });
}

async function startServer() {
  const inUse = await checkPort(PORT);

  if (inUse) {
    console.log(`Port ${PORT} in use. Stopping existing process...`);
    await killPort(PORT);
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`Starting server on port ${PORT}...`);

  const projectDir = path.resolve(__dirname, '..');

  const child = spawn('node', ['server.js'], {
    stdio: 'inherit',
    cwd: projectDir
  });

  child.on('error', (err) => console.error('Failed to start:', err));
}

startServer();
