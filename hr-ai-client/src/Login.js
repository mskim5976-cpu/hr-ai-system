import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import "./Login.css";

function Login() {
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  const navigate = useNavigate();

  const handleLogin = () => {
    if (id === "admin" && pw === "imsi00") {
      navigate("/home");
    } else {
      alert("로그인 실패! ID 또는 비밀번호를 확인하세요.");
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleLogin();
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <img src="/logo.png" alt="KCS 로고" className="login-logo" />

        <div className="login-title">인사관리시스템</div>
        <div className="login-subtitle">KCS(주) 케이씨에스 내부 전용</div>

        <input
          className="login-input"
          type="text"
          placeholder="로그인 ID"
          value={id}
          onChange={(e) => setId(e.target.value)}
        />

        <input
          className="login-input"
          type="password"
          placeholder="비밀번호"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={handleKeyDown}
        />

        <button className="login-button" onClick={handleLogin}>
          로그인
        </button>

        <div className="login-footer">
          ID: <b>admin</b> / PW: <b>imsi00</b>
        </div>
      </div>
    </div>
  );
}

export default Login;

