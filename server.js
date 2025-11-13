require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const OpenAI = require('openai');

const app = express();
app.use(cors());
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get('/', (_, res) => res.send('HR API OK'));

app.get('/api/employees', async (_, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT e.id,e.name,e.position,e.hire_date,e.status,d.name AS department
       FROM employees e LEFT JOIN departments d ON e.department_id=d.id`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({message:'employees error'}); }
});

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

// 직원 추가 API
app.post('/api/employees', async (req, res) => {
  try {
    const { name, department_id, position, hire_date, email } = req.body;

    if (!name) {
      return res.status(400).json({ message: '이름은 필수입니다.' });
    }

    const sql =
      'INSERT INTO employees (name, department_id, position, hire_date, email, status) VALUES (?, ?, ?, ?, ?, "재직")';

    const [result] = await pool.query(sql, [
      name,
      department_id || null,
      position || null,
      hire_date || null,
      email || null,
    ]);

    res.json({ message: '직원 추가 성공', id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '직원 추가 중 오류' });
  }
});

app.listen(process.env.PORT || 4000, () =>
  console.log(`API on :${process.env.PORT || 4000}`)
);
