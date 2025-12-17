require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const OpenAI = require('openai');
const { exec } = require('child_process');
const util = require('util');
const net = require('net');
const execPromise = util.promisify(exec);

// 포트 체크 함수
const checkPort = (host, port, timeout = 2000) => {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let status = false;

    socket.setTimeout(timeout);
    socket.on('connect', () => {
      status = true;
      socket.destroy();
    });
    socket.on('timeout', () => {
      socket.destroy();
    });
    socket.on('error', () => {
      socket.destroy();
    });
    socket.on('close', () => {
      resolve({ port, open: status });
    });

    socket.connect(port, host);
  });
};

const app = express();
app.use(cors());
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ============================================
// 기본 라우트
// ============================================
app.get('/', (_, res) => res.send('HR API OK'));

// ============================================
// 인증 API
// ============================================
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: '아이디와 비밀번호를 입력하세요.' });
    }

    const [rows] = await pool.query(
      `SELECT id, username, name, role FROM users WHERE username = ? AND password = ?`,
      [username, password]
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    res.json({ user: rows[0], message: '로그인 성공' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: '로그인 오류' });
  }
});

// ============================================
// 대시보드 API
// ============================================
app.get('/api/dashboard/stats', async (_, res) => {
  try {
    // 직원 상태별 카운트
    const [statusCounts] = await pool.query(`
      SELECT status, COUNT(*) as count
      FROM employees
      GROUP BY status
    `);

    // 전체 직원 수
    const [totalCount] = await pool.query(`SELECT COUNT(*) as total FROM employees`);

    // 파견 사이트별 인원
    const [siteStats] = await pool.query(`
      SELECT s.name as site_name, COUNT(a.id) as employee_count
      FROM sites s
      LEFT JOIN assignments a ON s.id = a.site_id AND a.status = '진행중'
      WHERE s.status = '진행중'
      GROUP BY s.id, s.name
    `);

    // 최근 등록 인력 (5명)
    const [recentEmployees] = await pool.query(`
      SELECT id, name, position, applied_part, hire_date, status
      FROM employees
      ORDER BY id DESC
      LIMIT 5
    `);

    // 계약 만료 예정 (30일 이내)
    const [expiringContracts] = await pool.query(`
      SELECT name, contract_end,
             DATEDIFF(contract_end, CURDATE()) as days_left
      FROM sites
      WHERE contract_end BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
      ORDER BY contract_end
    `);

    // 파견 만료 예정 인력 (30일 이내)
    const [expiringAssignments] = await pool.query(`
      SELECT a.id, a.end_date, e.name as employee_name, e.applied_part,
             s.name as site_name, DATEDIFF(a.end_date, CURDATE()) as days_left
      FROM assignments a
      JOIN employees e ON a.employee_id = e.id
      JOIN sites s ON a.site_id = s.id
      WHERE a.status = '진행중'
        AND a.end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
      ORDER BY a.end_date
    `);

    res.json({
      statusCounts: statusCounts.reduce((acc, row) => {
        acc[row.status] = row.count;
        return acc;
      }, {}),
      total: totalCount[0].total,
      siteStats,
      recentEmployees,
      expiringContracts,
      expiringAssignments
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'dashboard stats error' });
  }
});

// ============================================
// 직원 API
// ============================================
app.get('/api/employees', async (req, res) => {
  try {
    const { status, search } = req.query;
    let query = `
      SELECT e.id, e.name, e.position, e.hire_date, e.status, e.email, e.phone,
             e.age, e.address, e.applied_part, e.birth_date,
             d.name AS department
      FROM employees e
      LEFT JOIN departments d ON e.department_id = d.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ` AND e.status = ?`;
      params.push(status);
    }
    if (search) {
      query += ` AND (e.name LIKE ? OR e.email LIKE ? OR e.phone LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    query += ` ORDER BY e.id DESC`;

    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'employees error' });
  }
});

app.get('/api/employees/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT e.*, d.name AS department,
             GROUP_CONCAT(CONCAT(s.name, ':', es.level) SEPARATOR ',') as skills
      FROM employees e
      LEFT JOIN departments d ON e.department_id = d.id
      LEFT JOIN employee_skills es ON e.id = es.employee_id
      LEFT JOIN skills s ON es.skill_id = s.id
      WHERE e.id = ?
      GROUP BY e.id
    `, [req.params.id]);

    if (!rows.length) return res.status(404).json({ message: 'not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'employee detail error' });
  }
});

app.post('/api/employees', async (req, res) => {
  try {
    const { name, department_id, position, hire_date, email, phone, age, address, applied_part, birth_date, skills } = req.body;

    if (!name) {
      return res.status(400).json({ message: '이름은 필수입니다.' });
    }

    const sql = `INSERT INTO employees
      (name, department_id, position, hire_date, email, phone, age, address, applied_part, birth_date, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '대기')`;

    const [result] = await pool.query(sql, [
      name,
      department_id || null,
      position || null,
      hire_date || null,
      email || null,
      phone || null,
      age || null,
      address || null,
      applied_part || null,
      birth_date || null,
    ]);

    // 기술역량 추가
    if (skills && skills.length > 0) {
      for (const skill of skills) {
        await pool.query(
          `INSERT INTO employee_skills (employee_id, skill_id, level) VALUES (?, ?, ?)`,
          [result.insertId, skill.id, skill.level || '중급']
        );
      }
    }

    res.json({ message: '직원 추가 성공', id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '직원 추가 중 오류' });
  }
});

app.put('/api/employees/:id', async (req, res) => {
  try {
    const { skills } = req.body;
    const employeeId = req.params.id;

    // 현재 직원 상태 조회 (파견중인지 확인)
    const [currentEmployee] = await pool.query(`SELECT status FROM employees WHERE id = ?`, [employeeId]);
    const currentStatus = currentEmployee[0]?.status;

    // 동적으로 업데이트할 필드만 처리
    const allowedFields = ['name', 'department_id', 'position', 'hire_date', 'email', 'phone', 'age', 'address', 'applied_part', 'birth_date', 'status'];
    const updates = [];
    const values = [];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(req.body[field] || null);
      }
    }

    if (updates.length > 0) {
      values.push(employeeId);
      await pool.query(`UPDATE employees SET ${updates.join(', ')} WHERE id = ?`, values);
    }

    // 파견중 → 다른 상태로 변경 시 진행중인 파견 자동 종료
    const newStatus = req.body.status;
    if (currentStatus === '파견중' && newStatus && newStatus !== '파견중') {
      const today = new Date().toISOString().split('T')[0];
      await pool.query(
        `UPDATE assignments SET status = '종료', end_date = ? WHERE employee_id = ? AND status = '진행중'`,
        [today, employeeId]
      );
    }

    // 기술역량 업데이트
    if (skills) {
      await pool.query(`DELETE FROM employee_skills WHERE employee_id = ?`, [employeeId]);
      for (const skill of skills) {
        await pool.query(
          `INSERT INTO employee_skills (employee_id, skill_id, level) VALUES (?, ?, ?)`,
          [employeeId, skill.id, skill.level || '중급']
        );
      }
    }

    res.json({ message: '직원 정보 수정 성공' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '직원 수정 중 오류' });
  }
});

app.delete('/api/employees/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM employees WHERE id = ?`, [req.params.id]);
    res.json({ message: '직원 삭제 성공' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '직원 삭제 중 오류' });
  }
});

// ============================================
// 기술역량 API
// ============================================
app.get('/api/skills', async (_, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM skills ORDER BY category, name`);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'skills error' });
  }
});

app.post('/api/employees/:id/skills', async (req, res) => {
  try {
    const { skills } = req.body;
    await pool.query(`DELETE FROM employee_skills WHERE employee_id = ?`, [req.params.id]);

    for (const skill of skills) {
      await pool.query(
        `INSERT INTO employee_skills (employee_id, skill_id, level) VALUES (?, ?, ?)`,
        [req.params.id, skill.id, skill.level || '중급']
      );
    }

    res.json({ message: '기술역량 저장 성공' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'skills save error' });
  }
});

// ============================================
// 파견 사이트 API
// ============================================
app.get('/api/sites', async (_, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.*,
             (SELECT COUNT(*) FROM assignments a WHERE a.site_id = s.id AND a.status = '진행중') as employee_count
      FROM sites s
      ORDER BY s.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'sites error' });
  }
});

app.get('/api/sites/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM sites WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'site detail error' });
  }
});

app.post('/api/sites', async (req, res) => {
  try {
    const { name, address, contact_person, contact_phone, contract_start, contract_end, contract_amount, contract_type, status } = req.body;

    const [result] = await pool.query(`
      INSERT INTO sites (name, address, contact_person, contact_phone, contract_start, contract_end, contract_amount, contract_type, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [name, address, contact_person, contact_phone, contract_start, contract_end, contract_amount, contract_type, status || '진행중']);

    res.json({ message: '사이트 등록 성공', id: result.insertId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'site create error' });
  }
});

app.put('/api/sites/:id', async (req, res) => {
  try {
    const { name, address, contact_person, contact_phone, contract_start, contract_end, contract_amount, contract_type, status } = req.body;

    await pool.query(`
      UPDATE sites SET
        name = ?, address = ?, contact_person = ?, contact_phone = ?,
        contract_start = ?, contract_end = ?, contract_amount = ?,
        contract_type = ?, status = ?
      WHERE id = ?
    `, [name, address, contact_person, contact_phone, contract_start, contract_end, contract_amount, contract_type, status, req.params.id]);

    res.json({ message: '사이트 수정 성공' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'site update error' });
  }
});

app.delete('/api/sites/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM sites WHERE id = ?`, [req.params.id]);
    res.json({ message: '사이트 삭제 성공' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'site delete error' });
  }
});

// ============================================
// 파견 배정 API
// ============================================
app.get('/api/assignments', async (req, res) => {
  try {
    const { status, site_id } = req.query;
    let query = `
      SELECT a.*, e.name as employee_name, e.position, e.applied_part,
             s.name as site_name
      FROM assignments a
      JOIN employees e ON a.employee_id = e.id
      JOIN sites s ON a.site_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ` AND a.status = ?`;
      params.push(status);
    }
    if (site_id) {
      query += ` AND a.site_id = ?`;
      params.push(site_id);
    }

    query += ` ORDER BY a.created_at DESC`;

    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'assignments error' });
  }
});

app.post('/api/assignments', async (req, res) => {
  try {
    const { employee_id, site_id, start_date, end_date, monthly_rate } = req.body;

    const [result] = await pool.query(`
      INSERT INTO assignments (employee_id, site_id, start_date, end_date, monthly_rate, status)
      VALUES (?, ?, ?, ?, ?, '진행중')
    `, [employee_id, site_id, start_date, end_date, monthly_rate]);

    // 직원 상태를 '파견중'으로 변경
    await pool.query(`UPDATE employees SET status = '파견중' WHERE id = ?`, [employee_id]);

    res.json({ message: '파견 배정 성공', id: result.insertId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'assignment create error' });
  }
});

app.put('/api/assignments/:id', async (req, res) => {
  try {
    // 현재 배정 정보 조회
    const [current] = await pool.query(`SELECT * FROM assignments WHERE id = ?`, [req.params.id]);
    if (!current.length) {
      return res.status(404).json({ message: 'assignment not found' });
    }

    // 동적으로 업데이트할 필드만 처리
    const allowedFields = ['start_date', 'end_date', 'monthly_rate', 'status'];
    const updates = [];
    const values = [];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(req.body[field] || null);
      }
    }

    if (updates.length > 0) {
      values.push(req.params.id);
      await pool.query(`UPDATE assignments SET ${updates.join(', ')} WHERE id = ?`, values);
    }

    // 파견 종료시 직원 상태 변경
    if (req.body.status === '종료') {
      await pool.query(`UPDATE employees SET status = '대기' WHERE id = ?`, [current[0].employee_id]);
    }

    res.json({ message: '파견 정보 수정 성공' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'assignment update error' });
  }
});

app.delete('/api/assignments/:id', async (req, res) => {
  try {
    const [current] = await pool.query(`SELECT * FROM assignments WHERE id = ?`, [req.params.id]);

    await pool.query(`DELETE FROM assignments WHERE id = ?`, [req.params.id]);

    // 직원 상태 변경
    if (current.length > 0) {
      await pool.query(`UPDATE employees SET status = '대기' WHERE id = ?`, [current[0].employee_id]);
    }

    res.json({ message: '파견 삭제 성공' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'assignment delete error' });
  }
});

// ============================================
// 서버 현황 API
// ============================================
app.get('/api/servers', async (_, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM servers ORDER BY created_at DESC`);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'servers error' });
  }
});

app.get('/api/servers/:id/status', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM servers WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'not found' });

    const server = rows[0];
    let pingResult = { alive: false, latency: null };
    let portResults = [];

    // Ping 체크
    try {
      const { stdout } = await execPromise(`ping -c 1 -W 2 ${server.ip_address}`);
      const match = stdout.match(/time=(\d+\.?\d*)/);
      pingResult = {
        alive: true,
        latency: match ? parseFloat(match[1]) : null
      };
    } catch (e) {
      pingResult = { alive: false, latency: null };
    }

    // 포트 체크
    if (server.ports) {
      const portList = server.ports.split(',').map(p => parseInt(p.trim())).filter(p => !isNaN(p));
      portResults = await Promise.all(
        portList.map(port => checkPort(server.ip_address, port))
      );
    }

    res.json({ ...server, ping: pingResult, portStatus: portResults });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'server status error' });
  }
});

app.post('/api/servers', async (req, res) => {
  try {
    const { name, ip_address, os, purpose, cpu, memory, disk, status, ports } = req.body;

    const [result] = await pool.query(`
      INSERT INTO servers (name, ip_address, os, purpose, cpu, memory, disk, status, ports)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [name, ip_address, os, purpose, cpu, memory, disk, status || '운영중', ports || null]);

    res.json({ message: '서버 등록 성공', id: result.insertId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'server create error' });
  }
});

app.put('/api/servers/:id', async (req, res) => {
  try {
    const { name, ip_address, os, purpose, cpu, memory, disk, status, ports } = req.body;

    await pool.query(`
      UPDATE servers SET
        name = ?, ip_address = ?, os = ?, purpose = ?,
        cpu = ?, memory = ?, disk = ?, status = ?, ports = ?
      WHERE id = ?
    `, [name, ip_address, os, purpose, cpu, memory, disk, status, ports, req.params.id]);

    res.json({ message: '서버 수정 성공' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'server update error' });
  }
});

app.delete('/api/servers/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM servers WHERE id = ?`, [req.params.id]);
    res.json({ message: '서버 삭제 성공' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'server delete error' });
  }
});

// ============================================
// AI 코멘트 API (기존)
// ============================================
app.post('/api/employees/:id/ai-comment', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT e.name,e.position,e.hire_date,e.status,d.name AS department
       FROM employees e LEFT JOIN departments d ON e.department_id=d.id
       WHERE e.id=?`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({message:'not found'});

    const emp = rows[0];
    const prompt = `한국 회사 인사담당자처럼 아래 직원 소개를 2~3줄 한국어로 작성:
이름:${emp.name}, 부서:${emp.department ?? '미배정'}, 직급:${emp.position ?? '직원'},
입사일:${emp.hire_date}, 재직상태:${emp.status}. 따뜻하고 존중하는 톤.`;

    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{role:'user', content: prompt}]
    });
    res.json({ comment: r.choices[0].message.content.trim() });
  } catch (e) { res.status(500).json({message:'ai error'}); }
});

// ============================================
// 서버 시작
// ============================================
app.listen(process.env.PORT || 4000, () =>
  console.log(`API on :${process.env.PORT || 4000}`)
);
