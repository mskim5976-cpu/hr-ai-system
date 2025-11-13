import React, { useEffect, useState } from "react";

function App() {
  const [employees, setEmployees] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(false);

  // 새 직원 입력 상태
  const [newEmp, setNewEmp] = useState({
    name: "",
    department_id: "",
    position: "",
    hire_date: "",
    email: "",
  });

  const API = "http://192.168.40.56:4000";

  const fetchEmployees = async () => {
    const res = await fetch(`${API}/api/employees`);
    const data = await res.json();
    setEmployees(data);
  };

  const generateComment = async (id) => {
    setLoading(true);
    setSelectedId(id);
    setComment("생성 중...");
    const res = await fetch(`${API}/api/employees/${id}/ai-comment`, {
      method: "POST",
    });
    const data = await res.json();
    setComment(data.comment || "(결과 없음)");
    setLoading(false);
  };

  // 직원 추가 요청
  const addEmployee = async () => {
    if (!newEmp.name) {
      alert("이름은 필수입니다.");
      return;
    }

    const res = await fetch(`${API}/api/employees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newEmp),
    });

    const data = await res.json();
    if (data.id) {
      alert("직원 추가 완료!");
      fetchEmployees(); // 목록 새로고침
      setNewEmp({ name: "", department_id: "", position: "", hire_date: "", email: "" });
    } else {
      alert("직원 추가 실패");
    }
  };

  useEffect(() => {
    fetchEmployees();
  }, []);

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif" }}>
      <h1>👩‍💼 인사관리 시스템 (AI 코멘트 포함)</h1>

      <h2>📌 직원 추가</h2>
      <div style={{ border: "1px solid #ccc", padding: 15, marginBottom: 20 }}>
        <input
          placeholder="이름"
          value={newEmp.name}
          onChange={(e) => setNewEmp({ ...newEmp, name: e.target.value })}
          style={{ marginRight: 10 }}
        />
        <input
          placeholder="부서 ID"
          value={newEmp.department_id}
          onChange={(e) => setNewEmp({ ...newEmp, department_id: e.target.value })}
          style={{ marginRight: 10 }}
        />
        <input
          placeholder="직급"
          value={newEmp.position}
          onChange={(e) => setNewEmp({ ...newEmp, position: e.target.value })}
          style={{ marginRight: 10 }}
        />
        <input
          type="date"
          value={newEmp.hire_date}
          onChange={(e) => setNewEmp({ ...newEmp, hire_date: e.target.value })}
          style={{ marginRight: 10 }}
        />
        <input
          placeholder="이메일"
          value={newEmp.email}
          onChange={(e) => setNewEmp({ ...newEmp, email: e.target.value })}
          style={{ marginRight: 10 }}
        />
        <button onClick={addEmployee}>➕ 직원 추가</button>
      </div>

      <h2>📋 직원 목록</h2>
      <table
        border="1"
        cellPadding="8"
        style={{ borderCollapse: "collapse", width: "100%" }}
      >
        <thead>
          <tr style={{ background: "#eee" }}>
            <th>ID</th>
            <th>이름</th>
            <th>부서</th>
            <th>직급</th>
            <th>입사일</th>
            <th>AI 코멘트</th>
          </tr>
        </thead>
        <tbody>
          {employees.map((emp) => (
            <tr key={emp.id}>
              <td>{emp.id}</td>
              <td>{emp.name}</td>
              <td>{emp.department}</td>
              <td>{emp.position}</td>
              <td>{emp.hire_date}</td>
              <td>
                <button onClick={() => generateComment(emp.id)}>
                  {loading && selectedId === emp.id ? "생성 중..." : "AI 코멘트"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 30 }}>
        <h3>🗣️ AI 코멘트 결과</h3>
        <div
          style={{
            border: "1px solid #ddd",
            padding: 15,
            minHeight: 80,
            backgroundColor: "#fafafa",
          }}
        >
          {comment}
        </div>
      </div>
    </div>
  );
}

export default App;

