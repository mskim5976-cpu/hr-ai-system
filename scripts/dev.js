const { spawn, exec } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 4040;

// Check if port is in use (using netstat for reliability)
function checkPort(port) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec(`netstat -ano | findstr :${port} | findstr LISTENING`, { shell: 'cmd.exe' }, (err, stdout) => {
        resolve(stdout && stdout.trim().length > 0);
      });
    } else {
      exec(`lsof -ti:${port}`, (err, stdout) => {
        resolve(stdout && stdout.trim().length > 0);
      });
    }
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
