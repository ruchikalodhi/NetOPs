@echo off
title BPCL NetOps Dashboard Launcher
echo =======================================================
echo               BPCL NetOps Dashboard Launcher
echo =======================================================
echo.
echo Starting FastAPI Backend Server on http://localhost:8000...
start "BPCL NetOps Backend" cmd /k "cd backend && python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000"
echo.
echo Starting Vite Frontend Dev Server on http://localhost:5173...
start "BPCL NetOps Frontend" cmd /k "cd frontend && npm run dev"
echo.
echo =======================================================
echo Both services are starting...
echo - Backend API: http://localhost:8000
echo - Frontend GUI: http://localhost:5173
echo.
echo Press any key to exit this launcher window.
echo (The spawned server windows will remain running)
echo =======================================================
pause > null
del null
