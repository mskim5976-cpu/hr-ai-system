const { exec } = require('child_process');

const PORT = process.env.PORT || 4040;

function killPort(port) {
  if (process.platform === 'win32') {
    exec(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /F /PID %a`,
      { shell: 'cmd.exe' }, (err) => {
        console.log(err ? 'No process found' : `Stopped process on port ${port}`);
      });
  } else {
    exec(`lsof -ti:${port} | xargs kill -9 2>/dev/null`, (err) => {
      console.log(err ? 'No process found' : `Stopped process on port ${port}`);
    });
  }
}

killPort(PORT);
