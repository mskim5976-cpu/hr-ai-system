require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const OpenAI = require('openai');
const { exec } = require('child_process');
const util = require('util');
const net = require('net');
const execPromise = util.promisify(exec);
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

// 파일 업로드 설정
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (!file || !file.originalname) {
      return cb(new Error('파일 정보가 올바르지 않습니다.'));
    }
    const allowedTypes = ['.pdf', '.hwp', '.docx', '.doc', '.xlsx', '.xls', '.txt', '.csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('지원하지 않는 파일 형식입니다.'));
    }
  }
});

// 로컬 시간 기반 날짜 문자열 생성 (UTC 변환 이슈 방지)
const getLocalDateString = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

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

// Date 객체의 JSON 직렬화를 로컬 시간 기준으로 변경 (UTC 변환 방지)
Date.prototype.toJSON = function() {
  const year = this.getFullYear();
  const month = String(this.getMonth() + 1).padStart(2, '0');
  const day = String(this.getDate()).padStart(2, '0');
  const hours = String(this.getHours()).padStart(2, '0');
  const minutes = String(this.getMinutes()).padStart(2, '0');
  const seconds = String(this.getSeconds()).padStart(2, '0');

  // 시간이 00:00:00이면 날짜만 반환, 아니면 시간 포함
  if (hours === '00' && minutes === '00' && seconds === '00') {
    return `${year}-${month}-${day}`;
  }
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

const app = express();
app.use(cors());
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ============================================
// 기본 라우트
// ============================================
app.get('/', (_, res) => res.send('HR API OK'));

// AI 서버 상태 확인 API
app.get('/api/ai/health', async (req, res) => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch('http://211.236.174.220:4001/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer sk-1234'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      res.json({
        status: 'connected',
        message: 'AI 서버 연결됨',
        models: data.data?.map(m => m.id) || [],
      });
    } else {
      res.json({ status: 'error', message: `AI 서버 응답 오류: ${response.status}` });
    }
  } catch (error) {
    res.json({ status: 'disconnected', message: 'AI 서버 연결 실패' });
  }
});

// ============================================
// AI 이력서 파싱 API
// ============================================

// 파일에서 텍스트 추출 함수
async function extractTextFromFile(filePath, originalName) {
  if (!originalName) {
    throw new Error('파일 이름 정보가 없습니다.');
  }
  const ext = path.extname(originalName).toLowerCase();
  let text = '';

  try {
    if (ext === '.pdf') {
      const dataBuffer = fs.readFileSync(filePath);
      const parser = new PDFParse({ data: dataBuffer });
      const result = await parser.getText();
      text = result.text;
      await parser.destroy();  // 메모리 누수 방지
    } else if (ext === '.docx' || ext === '.doc') {
      const result = await mammoth.extractRawText({ path: filePath });
      text = result.value;
    } else if (ext === '.xlsx' || ext === '.xls') {
      const workbook = xlsx.readFile(filePath);
      const sheetNames = workbook.SheetNames;
      sheetNames.forEach(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        text += xlsx.utils.sheet_to_txt(sheet) + '\n';
      });
    } else if (ext === '.txt' || ext === '.csv') {
      text = fs.readFileSync(filePath, 'utf-8');
    } else if (ext === '.hwp') {
      // HWP는 복잡한 형식이라 기본 텍스트 추출 시도
      text = fs.readFileSync(filePath, 'utf-8');
    }
  } catch (error) {
    console.error('파일 텍스트 추출 오류:', error);
    throw new Error('파일 내용을 읽을 수 없습니다.');
  }

  return text;
}

// AI로 이력서 분석
app.post('/api/ai/parse-resume', upload.single('resume'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: '파일이 업로드되지 않았습니다.' });
  }

  const filePath = req.file.path;
  const originalName = req.file.originalname;

  try {
    // 1. 파일에서 텍스트 추출
    const resumeText = await extractTextFromFile(filePath, originalName);

    if (!resumeText || resumeText.trim().length < 10) {
      throw new Error('이력서에서 텍스트를 추출할 수 없습니다.');
    }

    // 2. AI API 호출
    const http = require('http');
    const aiPrompt = `다음 이력서 내용을 분석하여 아래 JSON 형식으로 정보를 추출해주세요.
반드시 JSON 형식으로만 응답하고, 다른 설명은 하지 마세요.
정보가 없는 필드는 빈 문자열("")로 남겨두세요.

추출할 필드:
{
  "name": "이름",
  "phone": "연락처 (010-0000-0000 형식)",
  "email": "이메일",
  "age": "나이 (숫자만)",
  "birth_date": "생년월일 (YYYY-MM-DD 형식)",
  "address": "주소",
  "gender": "성별 (남성 또는 여성)",
  "applied_part": "담당업무/직무 (Backend, Frontend, Fullstack, DevOps, DBA, QA, PM 중 하나)",
  "work_history": [
    {
      "company_name": "회사명",
      "period": "근무기간 (예: 2020.01 ~ 2022.12)",
      "applied_part": "담당업무",
      "position": "직급"
    }
  ],
  "project_history": [
    {
      "project_name": "프로젝트명",
      "period_start": "시작일 (YYYY-MM 형식)",
      "period_end": "종료일 (YYYY-MM 형식)",
      "client": "고객사",
      "company": "소속회사",
      "employment_type": "고용형태 (정규직, 계약직, 파견, 프리랜서, 도급 중 하나)",
      "role": "역할/주업무",
      "environment": "개발환경/기술스택"
    }
  ],
  "skills": [
    {"name": "Java", "level": "고급"},
    {"name": "Spring Boot", "level": "중급"},
    {"name": "React", "level": "초급"}
  ]
}

기술역량 레벨 평가 기준:
- 고급: 5년 이상 경험 또는 다수 프로젝트에서 핵심 기술로 사용한 경우
- 중급: 2-5년 경험 또는 실무 프로젝트 경험이 있는 경우
- 초급: 2년 미만 경험 또는 학습/토이 프로젝트 수준인 경우

이력서의 경력, 프로젝트 경험, 사용 빈도 등을 종합적으로 분석하여 각 기술별로 적절한 레벨을 평가해주세요.

이력서 내용:
${resumeText.substring(0, 8000)}`;

    const requestData = JSON.stringify({
      model: 'llama-8b',
      messages: [
        { role: 'system', content: '당신은 이력서를 분석하여 구조화된 JSON 데이터로 변환하는 전문가입니다. 반드시 유효한 JSON만 응답하세요.' },
        { role: 'user', content: aiPrompt }
      ],
      max_tokens: 4096,
      temperature: 0.1
    });

    const aiResponse = await new Promise((resolve, reject) => {
      const options = {
        hostname: '211.236.174.220',
        port: 4001,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer sk-1234',
          'Content-Length': Buffer.byteLength(requestData)
        },
        timeout: 180000
      };

      const request = http.request(options, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (e) {
            reject(new Error('AI 응답 파싱 오류'));
          }
        });
      });

      request.on('error', (e) => reject(new Error('AI 서버 연결 실패: ' + e.message)));
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('AI 서버 응답 시간 초과'));
      });

      request.write(requestData);
      request.end();
    });

    // 3. AI 응답에서 JSON 추출
    let parsedData = {};
    if (aiResponse.choices && aiResponse.choices[0] && aiResponse.choices[0].message) {
      const content = aiResponse.choices[0].message.content;
      // JSON 블록 추출 시도
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsedData = JSON.parse(jsonMatch[0]);
        } catch (e) {
          console.error('JSON 파싱 오류:', e);
        }
      }
    }

    // 4. 임시 파일 삭제
    fs.unlinkSync(filePath);

    res.json({
      success: true,
      message: '이력서 분석 완료',
      data: parsedData,
      rawText: resumeText.substring(0, 500) + '...'
    });

  } catch (error) {
    // 임시 파일 삭제
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    console.error('이력서 파싱 오류:', error);
    res.status(500).json({ message: error.message || '이력서 분석 중 오류가 발생했습니다.' });
  }
});

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
             e.age, e.address, e.applied_part, e.birth_date, e.gender,
             e.current_applied_part, e.current_position, e.current_company,
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
      query += ` AND (
        e.name LIKE ? OR
        e.email LIKE ? OR
        e.phone LIKE ? OR
        e.address LIKE ? OR
        e.gender LIKE ? OR
        e.position LIKE ? OR
        e.applied_part LIKE ? OR
        e.status LIKE ? OR
        e.work_history LIKE ? OR
        e.project_history LIKE ?
      )`;
      const searchParam = `%${search}%`;
      params.push(searchParam, searchParam, searchParam, searchParam, searchParam, searchParam, searchParam, searchParam, searchParam, searchParam);
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
    const { name, department_id, position, hire_date, email, phone, age, address, applied_part, birth_date, skills, project_history, gender, current_company, work_period, work_history, current_applied_part, current_position } = req.body;

    if (!name) {
      return res.status(400).json({ message: '이름은 필수입니다.' });
    }

    const sql = `INSERT INTO employees
      (name, department_id, position, hire_date, email, phone, age, address, applied_part, birth_date, status, project_history, gender, current_company, work_period, work_history, current_applied_part, current_position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '대기', ?, ?, ?, ?, ?, ?, ?)`;

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
      project_history || null,
      gender || null,
      current_company || null,
      work_period || null,
      work_history || null,
      current_applied_part || null,
      current_position || null,
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
    const allowedFields = ['name', 'department_id', 'position', 'hire_date', 'email', 'phone', 'age', 'address', 'applied_part', 'birth_date', 'status', 'project_history', 'gender', 'current_company', 'work_period', 'work_history', 'current_applied_part', 'current_position'];
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
      const today = getLocalDateString();
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

    // 상태 자동 계산 (계약기간 기반)
    // 한국 시간 기준 오늘 날짜
    const now = new Date();
    const koreaTime = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    const today = koreaTime.toISOString().split('T')[0];

    rows.forEach(site => {
      // 날짜를 YYYY-MM-DD 문자열로 변환
      let endDate = null;
      let startDate = null;

      if (site.contract_end) {
        endDate = site.contract_end instanceof Date
          ? site.contract_end.toISOString().split('T')[0]
          : String(site.contract_end).split('T')[0];
      }

      if (site.contract_start) {
        startDate = site.contract_start instanceof Date
          ? site.contract_start.toISOString().split('T')[0]
          : String(site.contract_start).split('T')[0];
      }

      // 상태 자동 계산
      if (endDate && endDate < today) {
        site.status = '종료';
      } else if (startDate && startDate > today) {
        site.status = '대기';
      } else {
        site.status = '진행중';
      }
    });

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
    const { name, project_name, address, contact_person, contact_phone, contract_start, contract_end, contract_amount, contract_type, status } = req.body;

    const [result] = await pool.query(`
      INSERT INTO sites (name, project_name, address, contact_person, contact_phone, contract_start, contract_end, contract_amount, contract_type, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [name, project_name || null, address, contact_person, contact_phone, contract_start, contract_end, contract_amount, contract_type, status || '진행중']);

    res.json({ message: '사이트 등록 성공', id: result.insertId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'site create error' });
  }
});

app.put('/api/sites/:id', async (req, res) => {
  try {
    const { name, project_name, address, contact_person, contact_phone, contract_start, contract_end, contract_amount, contract_type, status } = req.body;

    await pool.query(`
      UPDATE sites SET
        name = ?, project_name = ?, address = ?, contact_person = ?, contact_phone = ?,
        contract_start = ?, contract_end = ?, contract_amount = ?,
        contract_type = ?, status = ?
      WHERE id = ?
    `, [name, project_name || null, address, contact_person, contact_phone, contract_start, contract_end, contract_amount, contract_type, status, req.params.id]);

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
             e.current_applied_part, e.current_position,
             s.name as site_name, s.project_name as site_project_name
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
    const allowedFields = ['site_id', 'start_date', 'end_date', 'monthly_rate', 'status'];
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
// AI 보고서 API (사내 AI 서버 사용)
// ============================================
const AI_SERVER_URL = 'http://211.236.174.220:4001/v1/chat/completions';
const AI_MODELS_URL = 'http://211.236.174.220:4001/v1/models';

app.post('/api/ai/report', async (req, res) => {
  try {
    // 1. 대시보드 통계 데이터 수집
    const [statusCounts] = await pool.query(`
      SELECT status, COUNT(*) as count
      FROM employees
      GROUP BY status
    `);

    const [totalCount] = await pool.query(`SELECT COUNT(*) as total FROM employees`);

    const [siteStats] = await pool.query(`
      SELECT s.name as site_name, COUNT(a.id) as employee_count
      FROM sites s
      LEFT JOIN assignments a ON s.id = a.site_id AND a.status = '진행중'
      WHERE s.status = '진행중'
      GROUP BY s.id, s.name
    `);

    const [expiringContracts] = await pool.query(`
      SELECT name, contract_end,
             DATEDIFF(contract_end, CURDATE()) as days_left
      FROM sites
      WHERE contract_end BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
      ORDER BY contract_end
    `);

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

    // 2. 통계 데이터 정리
    const statusMap = statusCounts.reduce((acc, row) => {
      acc[row.status] = row.count;
      return acc;
    }, {});

    // 3. 프롬프트 구성
    const today = getLocalDateString();
    const prompt = `당신은 IT 인력 관리 전문가입니다. 아래 데이터를 바탕으로 인력현황요약보고서를 작성해주세요.

## 현재 날짜: ${today}

## 인력 현황
- 전체 인원: ${totalCount[0].total}명
- 파견중: ${statusMap['파견중'] || 0}명
- 대기: ${statusMap['대기'] || 0}명
- 재직: ${statusMap['재직'] || 0}명
- 퇴사: ${statusMap['퇴사'] || 0}명

## 파견 사이트별 인원
${siteStats.map(s => `- ${s.site_name}: ${s.employee_count}명`).join('\n') || '- 파견 데이터 없음'}

## 계약 만료 예정 사이트 (30일 이내)
${expiringContracts.map(c => `- ${c.name}: ${c.contract_end.toISOString().split('T')[0]} (${c.days_left}일 남음)`).join('\n') || '- 해당 없음'}

## 파견 만료 예정 인력 (30일 이내)
${expiringAssignments.map(a => `- ${a.employee_name} (${a.applied_part || '미지정'}): ${a.site_name} - ${a.end_date.toISOString().split('T')[0]} (${a.days_left}일 남음)`).join('\n') || '- 해당 없음'}

---
위 데이터를 기반으로 아래 형식 그대로 보고서를 작성해주세요. 반드시 **숫자. 제목** 형식을 지켜주세요:

**1. 요약**
전체 인력 현황을 2~3문장으로 요약

**2. 주요 현황**
- **사이트명**: 인원수
형식으로 파견 현황 정리

**3. 주의 사항**
- **만료일**: 해당 내용
형식으로 만료 예정 건 정리

**4. 권고 사항**
1. **권고제목** 권고내용
형식으로 권고사항 정리

보고서는 한국어로 작성하고, 전문적이고 간결한 톤을 유지해주세요.`;

    // 4. 사내 AI 서버 호출 (재시도 로직 포함)
    const MAX_RETRIES = 3;
    let reportContent = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      console.log(`AI 요청 시도 ${attempt}/${MAX_RETRIES}`);

      const aiResponse = await fetch(AI_SERVER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer sk-1234',
        },
        body: JSON.stringify({
          model: 'gpt-oss',
          messages: [
            { role: 'user', content: prompt }
          ],
          max_tokens: 4096,
          temperature: 0.7,
        }),
      });

      if (!aiResponse.ok) {
        throw new Error(`AI server error: ${aiResponse.status}`);
      }

      const aiData = await aiResponse.json();
      console.log('AI Response:', JSON.stringify(aiData, null, 2));

      reportContent = aiData.choices[0]?.message?.content;

      if (reportContent) {
        console.log(`성공: ${attempt}번째 시도에서 응답 받음`);
        break;
      }

      console.log(`실패: content가 null (finish_reason: ${aiData.choices[0]?.finish_reason})`);

      if (attempt < MAX_RETRIES) {
        console.log('재시도 중...');
      }
    }

    if (!reportContent) {
      reportContent = '보고서 생성에 실패했습니다. (3회 재시도 후 실패)';
    }

    // 5. 결과 반환
    res.json({
      report: reportContent,
      generatedAt: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
      stats: {
        total: totalCount[0].total,
        statusCounts: statusMap,
        siteStats,
        expiringContracts: expiringContracts.length,
        expiringAssignments: expiringAssignments.length,
      }
    });
  } catch (e) {
    console.error('AI Report Error:', e);
    res.status(500).json({ message: 'AI 보고서 생성 오류', error: e.message });
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
// AI 보고서 저장/조회 API
// ============================================

// 테이블 초기화 함수
const initReportsTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_reports (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT,
        generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('ai_reports table ready');
  } catch (e) {
    console.error('Failed to create ai_reports table:', e);
  }
};

// DB 마이그레이션 함수 (sites 테이블에 project_name 컬럼 추가)
const runMigrations = async () => {
  try {
    // project_name 컬럼 존재 여부 확인
    const [columns] = await pool.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sites'
      AND COLUMN_NAME = 'project_name'
    `);

    if (columns.length === 0) {
      console.log('Adding project_name column to sites table...');
      await pool.query(`ALTER TABLE sites ADD COLUMN project_name VARCHAR(255) AFTER name`);
      console.log('project_name column added successfully');
    } else {
      console.log('project_name column already exists');
    }
  } catch (error) {
    console.error('Migration error:', error);
  }
};

// 보고서 저장
app.post('/api/ai/reports', async (req, res) => {
  try {
    const { title, content } = req.body;
    const [result] = await pool.query(
      `INSERT INTO ai_reports (title, content) VALUES (?, ?)`,
      [title, content]
    );
    res.json({ id: result.insertId, message: '보고서 저장 성공' });
  } catch (e) {
    console.error('Report save error:', e);
    res.status(500).json({ message: '보고서 저장 오류' });
  }
});

// 보고서 목록 조회 (페이지네이션 지원)
app.get('/api/ai/reports', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) as total FROM ai_reports`);
    const [rows] = await pool.query(
      `SELECT id, title, generated_at FROM ai_reports ORDER BY generated_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    res.json({
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (e) {
    console.error('Report list error:', e);
    res.status(500).json({ message: '보고서 목록 조회 오류' });
  }
});

// 보고서 상세 조회
app.get('/api/ai/reports/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM ai_reports WHERE id = ?`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ message: '보고서를 찾을 수 없습니다' });
    }
    res.json(rows[0]);
  } catch (e) {
    console.error('Report detail error:', e);
    res.status(500).json({ message: '보고서 조회 오류' });
  }
});

// 보고서 삭제
app.delete('/api/ai/reports/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM ai_reports WHERE id = ?`, [req.params.id]);
    res.json({ message: '보고서 삭제 성공' });
  } catch (e) {
    console.error('Report delete error:', e);
    res.status(500).json({ message: '보고서 삭제 오류' });
  }
});

// ============================================
// Multer 에러 핸들러
// ============================================
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ message: '파일 크기가 10MB를 초과합니다.' });
    }
    return res.status(400).json({ message: '파일 업로드 오류: ' + err.message });
  } else if (err) {
    return res.status(400).json({ message: err.message || '요청 처리 오류' });
  }
  next();
});

// ============================================
// 서버 시작
// ============================================
app.listen(process.env.PORT || 4000, async () => {
  await runMigrations();  // DB 마이그레이션 실행
  await initReportsTable();
  console.log(`API on :${process.env.PORT || 4000}`);
});
