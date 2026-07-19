import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import {
  LayoutDashboard,
  TabletSmartphone,
  SlidersHorizontal,
  Factory,
  SunMedium,
  MoonStar,
  ShieldCheck,
  BarChart3,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Filter,
  X,
  Cpu,
  Layers,
  Settings,
  Trophy,
  History,
  UserPlus,
  Users,
  Download,
  Flame,
  UserCheck
} from 'lucide-react';
import Header from './components/Header';
import LoginScreen from './components/LoginScreen';
import SummaryBar from './components/SummaryBar';
import MachineCard from './components/MachineCard';
import OperatorTerminal from './components/OperatorTerminal';
import { ToastProvider, useToast } from './components/Toast';
import DashboardSkeleton from './components/Skeleton';
import MachineManagement from './components/MachineManagement';
import AuditLogView from './components/AuditLogView';
import jbmLogo from './assets/jbmlogo (1).png';
import roseLogo from './assets/rose logo (1).png';

// Charting, the historical reports table, and the Excel-export-capable shift planner pull in
// recharts/xlsx that most sessions never touch (operators live in the kiosk view) - split
// them out of the main bundle.
const AnalyticsCharts = lazy(() => import('./components/AnalyticsCharts'));
const ReportsLog = lazy(() => import('./components/ReportsLog'));
const ShiftPlanningCalendar = lazy(() => import('./components/ShiftPlanningCalendar'));

function ViewLoadingFallback() {
  return (
    <div className="py-24 text-center text-slate-400 font-bold uppercase tracking-widest bg-[var(--white-color)] border border-[var(--grey-200)] rounded-2xl">
      Loading...
    </div>
  );
}
import { WS_URL, apiFetch, AuthError } from './lib/api';

const SHIFT_OPTIONS = ['All Shifts', 'Shift A', 'Shift B', 'Shift C'];
const STATUS_OPTIONS = ['All', 'Running', 'Stopped', 'No Signal'];
const ROLE_OPTIONS = ['Supervisor', 'PPC Engineer', 'Admin', 'Operator'];

function getShiftFromTimestamp(timestamp) {
  if (!timestamp) return 'Shift A';

  const d = new Date(timestamp);
  const minutes = d.getHours() * 60 + d.getMinutes();
  if (minutes >= 7 * 60 && minutes < 15.5 * 60) return 'Shift A';
  if (minutes >= 15.5 * 60 && minutes < 24 * 60) return 'Shift B';
  return 'Shift C';
}

function AppShell() {
  const { showToast } = useToast();
  const [activeView, setActiveView] = useState('overview');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  
  // Tab metric state
  const [activeMetricTab, setActiveMetricTab] = useState('OEE');
  
  // Data states
  const [machines, setMachines] = useState([]);
  const [histories, setHistories] = useState({});
  const [reports, setReports] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [reasonCodes, setReasonCodes] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [socketConnected, setSocketConnected] = useState(false);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);

  // User profile CRUD form states (Admin view)
  const [crudLoginId, setCrudLoginId] = useState('');
  const [crudRole, setCrudRole] = useState('Supervisor');
  const [crudDisplayName, setCrudDisplayName] = useState('');
  const [crudTerminalId, setCrudTerminalId] = useState('DASHBOARD');
  const [crudPassword, setCrudPassword] = useState('');
  const [crudEditing, setCrudEditing] = useState(false);
  const [crudSuccessMsg, setCrudSuccessMsg] = useState('');
  const [crudErrorMsg, setCrudErrorMsg] = useState('');

  const [authToken, setAuthToken] = useState(() => {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem('rep-iot-token') || null;
  });

  const [sessionUser, setSessionUser] = useState(() => {
    if (typeof window === 'undefined') return null;
    try {
      const rawSession = window.localStorage.getItem('rep-iot-session');
      return rawSession ? JSON.parse(rawSession) : null;
    } catch {
      return null;
    }
  });

  const [themeMode, setThemeMode] = useState(() => {
    if (typeof window === 'undefined') return 'light';
    return window.localStorage.getItem('rep-iot-theme') || 'light';
  });
  
  const operatingMode = 'Demo Mode';
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [shiftFilter, setShiftFilter] = useState('All Shifts');
  const [machineFilter, setMachineFilter] = useState('All Machines');
  const [dateFilter, setDateFilter] = useState('');

  // Local state for modal fields before applying
  const [tempStatus, setTempStatus] = useState('All');
  const [tempShift, setTempShift] = useState('All Shifts');
  const [tempMachine, setTempMachine] = useState('All Machines');
  const [tempDate, setTempDate] = useState('');

  // Kiosk mode: this build is a dedicated shop-floor touchscreen for one machine (served at
  // /operator). It auto-logs-in as a low-privilege station account so nobody has to type a
  // password at the machine, while every action still goes through real backend auth/audit -
  // unlike the old fully-anonymous kiosk, this is a named, revocable, Operator-scoped account.
  const isKioskMode = typeof window !== 'undefined' &&
    (window.location.pathname.endsWith('/operator') || window.location.search.includes('view=operator'));
  const [kioskAutoLoginDone, setKioskAutoLoginDone] = useState(false);

  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.body.dataset.theme = themeMode;
    window.localStorage.setItem('rep-iot-theme', themeMode);
  }, [themeMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (sessionUser && authToken) {
      window.localStorage.setItem('rep-iot-session', JSON.stringify(sessionUser));
      window.localStorage.setItem('rep-iot-token', authToken);
    } else {
      window.localStorage.removeItem('rep-iot-session');
      window.localStorage.removeItem('rep-iot-token');
    }
  }, [sessionUser, authToken]);

  // Centralizes "session expired" handling: any API call can throw AuthError and we
  // land here instead of every call site duplicating logout logic.
  const handleAuthError = (err) => {
    if (err instanceof AuthError) {
      showToast('Your session expired. Please log in again.', 'error');
      setSessionUser(null);
      setAuthToken(null);
      return true;
    }
    return false;
  };

  const fetchUserAccounts = async () => {
    if (sessionUser?.role !== 'Admin') return;
    try {
      const list = await apiFetch('/api/users', { token: authToken });
      setAccounts(list);
    } catch (err) {
      if (!handleAuthError(err)) console.error('Failed to fetch user profiles:', err.message);
    }
  };

  const fetchAuditLog = async () => {
    if (sessionUser?.role !== 'Admin') return;
    try {
      const list = await apiFetch('/api/audit-log', { token: authToken });
      setAuditLog(list);
    } catch (err) {
      if (!handleAuthError(err)) console.error('Failed to fetch audit log:', err.message);
    }
  };

  const handleLoginSuccess = (nextUser, token) => {
    setSessionUser(nextUser);
    setAuthToken(token);
    if (nextUser.role === 'PPC Engineer') {
      setActiveView('planning');
    } else if (nextUser.role === 'Operator') {
      setActiveView('operator');
    } else {
      setActiveView('overview');
    }
  };

  // Kiosk auto-login: only runs once, only in kiosk mode, only if this build was configured
  // with station credentials (VITE_KIOSK_LOGIN_ID/PASSWORD - set per-Pi, never in the cloud
  // build). Falls back to the normal manual LoginScreen if unconfigured or if it fails.
  useEffect(() => {
    if (!isKioskMode || sessionUser || kioskAutoLoginDone) return;

    const kioskLoginId = import.meta.env.VITE_KIOSK_LOGIN_ID;
    const kioskPassword = import.meta.env.VITE_KIOSK_PASSWORD;

    if (!kioskLoginId || !kioskPassword) {
      setKioskAutoLoginDone(true);
      return;
    }

    (async () => {
      try {
        const data = await apiFetch('/api/auth/login', {
          method: 'POST',
          body: { loginId: kioskLoginId, password: kioskPassword }
        });
        handleLoginSuccess(data.user, data.token);
      } catch (err) {
        console.error('Kiosk auto-login failed:', err.message);
      } finally {
        setKioskAutoLoginDone(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isKioskMode, sessionUser, kioskAutoLoginDone]);

  const handleLogout = () => {
    setSessionUser(null);
    setAuthToken(null);
    setInitialLoadComplete(false);
  };

  const fetchReports = async () => {
    try {
      const reportsList = await apiFetch('/api/reports', { token: authToken });
      setReports(reportsList);
    } catch (err) {
      if (!handleAuthError(err)) console.error('Failed to fetch reports logs:', err.message);
    }
  };

  const loadInitialData = async () => {
    try {
      const machinesList = await apiFetch('/api/machines', { token: authToken });
      setMachines(machinesList);

      if (reasonCodes.length === 0) {
        apiFetch('/api/reason-codes', { token: authToken }).then(setReasonCodes).catch(() => {});
      }

      if (!isKioskMode) {
        const historyEntries = await Promise.all(
          machinesList.map(async (machine) => {
            const historyList = await apiFetch(`/api/machines/${machine.id}/history`, { token: authToken });
            return [machine.id, historyList];
          })
        );

        setHistories(Object.fromEntries(historyEntries));
        await fetchReports();
        await fetchUserAccounts();
        await fetchAuditLog();
      }
    } catch (err) {
      if (!handleAuthError(err)) console.error('Failed to load initial data:', err.message);
    } finally {
      setInitialLoadComplete(true);
    }
  };

  useEffect(() => {
    if (!authToken) return undefined;

    loadInitialData();

    const connectWebSocket = () => {
      const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(authToken)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setSocketConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'WELCOME') {
            return;
          }

          if (data.type === 'PULSE') {
            const { machineId, pulse, metrics } = data;

            setMachines((prev) => prev.map((machine) => {
              if (machine.id !== machineId) return machine;

              return {
                ...machine,
                production_count: machine.production_count + 1,
                good_count: pulse.isGood ? machine.good_count + 1 : machine.good_count,
                scrap_count: !pulse.isGood ? machine.scrap_count + 1 : machine.scrap_count,
                last_pulse: pulse.timestamp,
                status: 'Running',
                metrics
              };
            }));

            setHistories((prev) => ({
              ...prev,
              [machineId]: [...(prev[machineId] || []), {
                id: Date.now() + Math.random(),
                timestamp: pulse.timestamp,
                cycle_time: pulse.cycleTime,
                is_good: pulse.isGood
              }].slice(-30)
            }));
          }

          if (data.type === 'STATUS_CHANGE') {
            const { machineId, status, metrics } = data;

            setMachines((prev) => prev.map((machine) => {
              if (machine.id !== machineId) return machine;

              return {
                ...machine,
                status,
                metrics
              };
            }));

            fetchReports();
          }

          if (data.type === 'SYNC_UPDATE') {
            const { machineId, production_count, good_count, scrap_count, last_pulse, status, metrics } = data;

            setMachines((prev) => prev.map((machine) => {
              if (machine.id !== machineId) return machine;

              return {
                ...machine,
                production_count: production_count !== undefined ? production_count : machine.production_count,
                good_count: good_count !== undefined ? good_count : machine.good_count,
                scrap_count: scrap_count !== undefined ? scrap_count : machine.scrap_count,
                last_pulse: last_pulse !== undefined ? last_pulse : machine.last_pulse,
                status: status !== undefined ? status : machine.status,
                metrics: metrics !== undefined ? metrics : machine.metrics
              };
            }));

            // Refresh logs and history as sync data has arrived
            const fetchUpdatedHistory = async () => {
              try {
                const historyList = await apiFetch(`/api/machines/${machineId}/history`, { token: authToken });
                setHistories((prev) => ({
                  ...prev,
                  [machineId]: historyList
                }));
              } catch (err) {
                console.error(`Failed to refresh history for machine ${machineId}:`, err.message);
              }
            };
            fetchUpdatedHistory();
            fetchReports();
          }

          if (data.type === 'ALERT') {
            setAlerts((prev) => [{ id: Date.now() + Math.random(), ...data }, ...prev].slice(0, 50));
            showToast(data.message, data.severity === 'critical' ? 'error' : 'warning');
          }
        } catch (err) {
          console.error('Error parsing WebSocket message:', err.message);
        }
      };

      ws.onclose = (event) => {
        setSocketConnected(false);
        // 4001 = server rejected an invalid/expired token - don't hammer it with retries,
        // the user needs to log in again instead.
        if (event.code === 4001) {
          handleLogout();
          return;
        }
        reconnectTimerRef.current = setTimeout(connectWebSocket, 3000);
      };

      ws.onerror = (err) => {
        console.error('WebSocket Error:', err.message);
        ws.close();
      };
    };

    connectWebSocket();

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
    // Intentionally only re-runs when authToken changes - loadInitialData/fetchReports/showToast
    // are stable enough in practice and including them would reconnect the socket every render.
  }, [authToken]);

  // Fallback Polling: if WebSocket connection fails or is blocked, periodically fetch machines telemetry
  useEffect(() => {
    if (!authToken || !initialLoadComplete) return undefined;

    const intervalTime = isKioskMode ? 1500 : 4000;

    const pollInterval = setInterval(() => {
      if (!socketConnected) {
        (async () => {
          try {
            const machinesList = await apiFetch('/api/machines', { token: authToken });
            setMachines(machinesList);
          } catch (err) {
            console.error('Fallback polling failed:', err.message);
          }
        })();
      }
    }, intervalTime);

    return () => clearInterval(pollInterval);
  }, [authToken, socketConnected, initialLoadComplete, isKioskMode]);



  const handleStopMachine = async (machineId) => {
    try {
      await apiFetch(`/api/machines/${machineId}/stop`, { method: 'POST', token: authToken });
    } catch (err) {
      if (!handleAuthError(err)) {
        console.error(`Failed to stop machine ${machineId}:`, err.message);
        showToast(err.message || `Failed to stop machine ${machineId}`, 'error');
      }
    }
  };

  const handleResumeMachine = async (machineId, reason, operatorId) => {
    try {
      await apiFetch(`/api/machines/${machineId}/resume`, { method: 'POST', token: authToken, body: { reason, operatorId } });
    } catch (err) {
      if (!handleAuthError(err)) {
        console.error(`Failed to resume machine ${machineId}:`, err.message);
        showToast(err.message || `Failed to resume machine ${machineId}`, 'error');
      }
    }
  };

  // User Profile CRUD Handlers (Admin only - enforced server-side too)
  const [pendingDeleteLoginId, setPendingDeleteLoginId] = useState(null);

  const handleAddUser = async (e) => {
    e.preventDefault();
    if (!crudLoginId || !crudDisplayName || !crudPassword) {
      setCrudErrorMsg('Display Name, Login ID, and Password are required.');
      return;
    }

    try {
      await apiFetch('/api/users', {
        method: 'POST',
        token: authToken,
        body: { loginId: crudLoginId, role: crudRole, displayName: crudDisplayName, terminalId: crudTerminalId, password: crudPassword }
      });
      setCrudSuccessMsg(`User profile ${crudLoginId} created successfully!`);
      setCrudLoginId('');
      setCrudDisplayName('');
      setCrudPassword('');
      setCrudErrorMsg('');
      fetchUserAccounts();
      fetchAuditLog();
      setTimeout(() => setCrudSuccessMsg(''), 4000);
    } catch (err) {
      if (!handleAuthError(err)) setCrudErrorMsg(err.message || 'Failed to create user profile.');
    }
  };

  const handleUpdateUser = async (e) => {
    e.preventDefault();
    try {
      await apiFetch(`/api/users/${crudLoginId}`, {
        method: 'PUT',
        token: authToken,
        body: { role: crudRole, displayName: crudDisplayName, terminalId: crudTerminalId, ...(crudPassword ? { password: crudPassword } : {}) }
      });
      setCrudSuccessMsg(`User profile ${crudLoginId} updated successfully!`);
      setCrudLoginId('');
      setCrudDisplayName('');
      setCrudPassword('');
      setCrudEditing(false);
      setCrudErrorMsg('');
      fetchUserAccounts();
      fetchAuditLog();
      setTimeout(() => setCrudSuccessMsg(''), 4000);
    } catch (err) {
      if (!handleAuthError(err)) setCrudErrorMsg(err.message || 'Failed to update profile.');
    }
  };

  const handleDeleteUser = (loginId) => {
    if (loginId === 'ADMIN') {
      showToast('The default ADMIN account cannot be deleted.', 'error');
      return;
    }
    setPendingDeleteLoginId(loginId);
  };

  const confirmDeleteUser = async () => {
    const loginId = pendingDeleteLoginId;
    setPendingDeleteLoginId(null);
    if (!loginId) return;
    try {
      await apiFetch(`/api/users/${loginId}`, { method: 'DELETE', token: authToken });
      setCrudSuccessMsg(`User profile ${loginId} deleted successfully.`);
      fetchUserAccounts();
      fetchAuditLog();
      setTimeout(() => setCrudSuccessMsg(''), 4000);
    } catch (err) {
      if (!handleAuthError(err)) {
        console.error('Failed to delete user profile:', err.message);
        showToast(err.message || 'Failed to delete user profile.', 'error');
      }
    }
  };

  const editUserSetup = (user) => {
    setCrudLoginId(user.loginId);
    setCrudRole(user.role);
    setCrudDisplayName(user.displayName);
    setCrudTerminalId(user.terminalId);
    setCrudPassword('');
    setCrudEditing(true);
  };

  // CSV Data Exporter (Blob method)
  const exportToCSV = (headers, data, filename) => {
    const csvRows = [];
    csvRows.push(headers.join(','));
    
    data.forEach(row => {
      const values = headers.map(header => {
        const val = row[header] !== undefined && row[header] !== null ? String(row[header]) : '';
        const escaped = val.replace(/"/g, '""');
        return `"${escaped}"`;
      });
      csvRows.push(values.join(','));
    });
    
    const csvString = csvRows.join("\n");
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Export downtime log
  const handleExportDowntime = () => {
    const headers = ['machine_id', 'machine_name', 'status', 'start_time', 'end_time', 'downtime_reason', 'operator_id', 'part_name'];
    const filename = `downtime_report_${new Date().toISOString().slice(0, 10)}.csv`;
    exportToCSV(headers, filteredReports, filename);
  };

  // Export production performance (OEE analysis)
  const handleExportProduction = () => {
    const headers = ['id', 'name', 'status', 'target', 'production_count', 'good_count', 'scrap_count', 'oee', 'availability', 'performance', 'quality'];
    const data = filteredMachines.map(m => ({
      id: m.id,
      name: m.name,
      status: m.status,
      target: m.target,
      production_count: m.production_count,
      good_count: m.good_count,
      scrap_count: m.scrap_count,
      oee: `${m.metrics?.oee || 0}%`,
      availability: `${m.metrics?.availability || 0}%`,
      performance: `${m.metrics?.performance || 0}%`,
      quality: `${m.metrics?.quality || 0}%`
    }));
    const filename = `production_oee_analysis_${new Date().toISOString().slice(0, 10)}.csv`;
    exportToCSV(headers, data, filename);
  };

  // Export Daily Plant Executive Report (Plant Head request)
  const handleExportPlantHeadReport = () => {
    const headers = ['Report_KPI', 'Value_Percentage', 'Target_Threshold', 'Status_Alert'];
    const plantOeeValue = averageOee.toFixed(1);
    const topReason = calculateBottleneckReason();
    const scrapRate = calculateTotalScrapRate();
    
    const data = [
      { Report_KPI: 'Plant Average OEE', Value_Percentage: `${plantOeeValue}%`, Target_Threshold: '85.0%', Status_Alert: parseFloat(plantOeeValue) >= 85 ? 'Normal' : 'Underperforming' },
      { Report_KPI: 'Primary Stoppage Bottleneck', Value_Percentage: topReason, Target_Threshold: 'None', Status_Alert: 'Review Required' },
      { Report_KPI: 'Total Scrap Defect Yield', Value_Percentage: `${scrapRate}%`, Target_Threshold: '< 2.0%', Status_Alert: parseFloat(scrapRate) < 2.0 ? 'Safe' : 'Critical Hazard' },
      { Report_KPI: 'Active Machines Connected', Value_Percentage: `${(machines.filter(m => m.status !== 'No Signal').length / (machines.length || 1) * 100).toFixed(1)}%`, Target_Threshold: '100.0%', Status_Alert: 'Live Sync OK' },
      { Report_KPI: 'Total Factory Pieces Produced', Value_Percentage: machines.reduce((sum, m) => sum + (m.production_count || 0), 0), Target_Threshold: machines.length * 100, Status_Alert: 'In Progress' }
    ];
    
    const filename = `plant_head_ops_summary_${new Date().toISOString().slice(0, 10)}.csv`;
    exportToCSV(headers, data, filename);
  };

  // Calculate live bottleneck cause from reports logs
  const calculateBottleneckReason = () => {
    const reasonsMap = {};
    filteredReports.forEach(log => {
      if (log.status === 'Stopped' && log.downtime_reason) {
        const start = new Date(log.start_time).getTime();
        const end = log.end_time ? new Date(log.end_time).getTime() : Date.now();
        const durationMins = Math.round((end - start) / 60000);
        reasonsMap[log.downtime_reason] = (reasonsMap[log.downtime_reason] || 0) + durationMins;
      }
    });
    let topReason = 'None';
    let maxDuration = 0;
    Object.keys(reasonsMap).forEach(r => {
      if (reasonsMap[r] > maxDuration) {
        maxDuration = reasonsMap[r];
        topReason = r;
      }
    });
    return topReason === 'None' ? 'No stoppages recorded' : `${topReason} (${Math.round(maxDuration / 60)}h ${maxDuration % 60}m)`;
  };

  // Calculate total plant scrap percentage
  const calculateTotalScrapRate = () => {
    const totalProd = machines.reduce((sum, m) => sum + (m.production_count || 0), 0);
    const totalScrap = machines.reduce((sum, m) => sum + (m.scrap_count || 0), 0);
    return totalProd > 0 ? ((totalScrap / totalProd) * 100).toFixed(2) : '0.00';
  };

  const normalizedSearch = searchTerm.trim().toLowerCase();

  const filteredMachines = machines.filter((machine) => {
    const searchMatches = !normalizedSearch || [
      machine.id,
      machine.name,
      machine.status
    ].some((value) => String(value || '').toLowerCase().includes(normalizedSearch));

    const statusMatches = statusFilter === 'All' || machine.status === statusFilter;
    const shiftMatches = shiftFilter === 'All Shifts' || (machine.metrics?.currentShift || 'Shift A') === shiftFilter;
    const machineMatches = machineFilter === 'All Machines' || machine.id === machineFilter;

    return searchMatches && statusMatches && shiftMatches && machineMatches;
  });

  const filteredReports = reports.filter((report) => {
    const reportShift = getShiftFromTimestamp(report.start_time);
    const reportDate = report.start_time ? new Date(report.start_time).toISOString().slice(0, 10) : '';

    const searchMatches = !normalizedSearch || [
      report.machine_name,
      report.machine_id,
      report.status,
      report.downtime_reason,
      report.part_name,
      reportShift,
      report.operator_id
    ].some((value) => String(value || '').toLowerCase().includes(normalizedSearch));

    const machineMatches = machineFilter === 'All Machines' || report.machine_id === machineFilter;
    const shiftMatches = shiftFilter === 'All Shifts' || reportShift === shiftFilter;
    const dateMatches = !dateFilter || reportDate === dateFilter;
    const statusMatches = statusFilter === 'All' || report.status === statusFilter;

    return searchMatches && machineMatches && shiftMatches && dateMatches && statusMatches;
  });

  const openFilterModal = () => {
    setTempStatus(statusFilter);
    setTempShift(shiftFilter);
    setTempMachine(machineFilter);
    setTempDate(dateFilter);
    setFilterModalOpen(true);
  };

  const applyFilters = () => {
    setStatusFilter(tempStatus);
    setShiftFilter(tempShift);
    setMachineFilter(tempMachine);
    setDateFilter(tempDate);
    setFilterModalOpen(false);
  };

  const resetFilters = () => {
    setSearchTerm('');
    setStatusFilter('All');
    setShiftFilter('All Shifts');
    setMachineFilter('All Machines');
    setDateFilter('');
    
    setTempStatus('All');
    setTempShift('All Shifts');
    setTempMachine('All Machines');
    setTempDate('');
    
    setFilterModalOpen(false);
  };

  // The kiosk touchscreen auto-logs-in (see effect above) instead of showing a login form.
  // A tablet stays signed in for the shift under one station account; individual badge
  // sign-on inside OperatorTerminal on top of that is purely informational.
  if (!sessionUser) {
    if (isKioskMode && !kioskAutoLoginDone) {
      return (
        <div className="min-h-screen w-screen bg-slate-950 flex items-center justify-center">
          <p className="text-slate-500 text-xs font-black uppercase tracking-widest">Connecting to station...</p>
        </div>
      );
    }
    return (
      <LoginScreen
        themeMode={themeMode}
        onToggleTheme={() => setThemeMode((mode) => (mode === 'light' ? 'dark' : 'light'))}
        onLoginSuccess={handleLoginSuccess}
      />
    );
  }

  if (isKioskMode) {
    return (
      <div className="min-h-screen w-screen bg-slate-950 overflow-hidden m-0 p-0">
        <OperatorTerminal
          machines={machines}
          onStopMachine={handleStopMachine}
          onResumeMachine={handleResumeMachine}
          operatingMode={operatingMode}
          sessionUser={sessionUser}
          reasonCodes={reasonCodes}
        />
      </div>
    );
  }

  const averageOee = filteredMachines.length > 0
    ? filteredMachines.reduce((sum, machine) => sum + (machine.metrics?.oee || 0), 0) / filteredMachines.length
    : 0;

  return (
    <div className="flex min-h-screen bg-[var(--bg-color-page)] font-sans transition-all duration-300">
      
      {/* Mobile Sidebar Overlay Backdrop */}
      {mobileSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/40 backdrop-blur-xs z-35 lg:hidden transition-opacity duration-300"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      {/* 1. LEFT SIDEBAR (Sticky on Desktop, Drawer on Mobile) */}
      <aside className={`bg-[var(--white-color)] border-r border-[var(--grey-200)] flex flex-col justify-between transition-all duration-300 ${sidebarCollapsed ? 'w-20' : 'w-72'} shrink-0 h-screen select-none fixed lg:sticky top-0 left-0 z-40 lg:z-20 lg:translate-x-0 ${mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div>
          {/* Logo Section */}
          <div className="p-5 border-b border-[var(--grey-200)] flex items-center justify-between">
            <div className="flex items-center gap-3 overflow-hidden">
              {sidebarCollapsed ? (
                <div className="bg-white p-1 rounded-xl shadow-xs border border-slate-100 shrink-0 flex flex-col gap-1 items-center justify-center">
                  <img src={jbmLogo} alt="JBM Logo" className="w-6 h-6 object-contain" />
                  <img src={roseLogo} alt="Rose Logo" className="w-6 h-6 object-contain" />
                </div>
              ) : (
                <div className="flex flex-col gap-2 w-fit bg-white p-2 rounded-xl shadow-sm border border-slate-100 animate-in fade-in duration-200">
                  <img src={jbmLogo} alt="JBM Logo" className="h-8.5 w-auto object-contain" />
                  <div className="h-[1px] w-full bg-slate-150"></div>
                  <img src={roseLogo} alt="Rose Logo" className="h-8.5 w-auto object-contain" />
                </div>
              )}
            </div>
          </div>

          {/* Expanded Sidebar Nav List */}
          <nav className="p-4 space-y-2.5 mt-6">
            {/* 1. Overview Dashboard */}
            <button
              onClick={() => { setActiveView('overview'); setMobileSidebarOpen(false); }}
              className={`w-full flex items-center gap-4 px-4 py-3.5 rounded-xl text-sm font-black uppercase tracking-wider transition-all ${
                activeView === 'overview'
                  ? 'bg-[var(--secondary2-trans-100)] text-[var(--primary)]'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
              }`}
            >
              <LayoutDashboard className="w-5 h-5 shrink-0" />
              {!sidebarCollapsed && <span>Dashboard Overview</span>}
            </button>

            {/* 2. Machine Status Cards Grid */}
            <button
              onClick={() => { setActiveView('machines'); setMobileSidebarOpen(false); }}
              className={`w-full flex items-center gap-4 px-4 py-3.5 rounded-xl text-sm font-black uppercase tracking-wider transition-all ${
                activeView === 'machines'
                  ? 'bg-[var(--secondary2-trans-100)] text-[var(--primary)]'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
              }`}
            >
              <Cpu className="w-5 h-5 shrink-0" />
              {!sidebarCollapsed && <span>Machine Status</span>}
            </button>

            {/* 3. Recharts Analytics */}
            <button
              onClick={() => { setActiveView('analytics'); setMobileSidebarOpen(false); }}
              className={`w-full flex items-center gap-4 px-4 py-3.5 rounded-xl text-sm font-black uppercase tracking-wider transition-all ${
                activeView === 'analytics'
                  ? 'bg-[var(--secondary2-trans-100)] text-[var(--primary)]'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
              }`}
            >
              <BarChart3 className="w-5 h-5 shrink-0" />
              {!sidebarCollapsed && <span>Analytics & Charts</span>}
            </button>

            {/* 4. PPC Shift Planner Board */}
            <button
              onClick={() => { setActiveView('planning'); setMobileSidebarOpen(false); }}
              disabled={sessionUser.role !== 'PPC Engineer' && sessionUser.role !== 'Admin'}
              className={`w-full flex items-center gap-4 px-4 py-3.5 rounded-xl text-sm font-black uppercase tracking-wider transition-all ${
                sessionUser.role !== 'PPC Engineer' && sessionUser.role !== 'Admin'
                  ? 'text-slate-300 cursor-not-allowed opacity-50'
                  : activeView === 'planning'
                  ? 'bg-[var(--secondary2-trans-100)] text-[var(--primary)]'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
              }`}
            >
              <History className="w-5 h-5 shrink-0" />
              {!sidebarCollapsed && <span>Planning Board</span>}
            </button>

            {/* 5. Downtime and Logs */}
            <button
              onClick={() => { setActiveView('reports'); setMobileSidebarOpen(false); }}
              className={`w-full flex items-center gap-4 px-4 py-3.5 rounded-xl text-sm font-black uppercase tracking-wider transition-all ${
                activeView === 'reports'
                  ? 'bg-[var(--secondary2-trans-100)] text-[var(--primary)]'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
              }`}
            >
              <Layers className="w-5 h-5 shrink-0" />
              {!sidebarCollapsed && <span>Downtime & Logs</span>}
            </button>

            {/* 6. Operator Simulator Panel */}
            <button
              onClick={() => { setActiveView('operator'); setMobileSidebarOpen(false); }}
              className={`w-full flex items-center gap-4 px-4 py-3.5 rounded-xl text-sm font-black uppercase tracking-wider transition-all ${
                activeView === 'operator'
                  ? 'bg-[var(--secondary2-trans-100)] text-[var(--primary)]'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
              }`}
            >
              <TabletSmartphone className="w-5 h-5 shrink-0" />
              {!sidebarCollapsed && <span>Operator Panel</span>}
            </button>

            {/* 7. User Profiles CRUD */}
            {sessionUser.role === 'Admin' && (
              <button
                onClick={() => { setActiveView('users'); setMobileSidebarOpen(false); }}
                className={`w-full flex items-center gap-4 px-4 py-3.5 rounded-xl text-sm font-black uppercase tracking-wider transition-all ${
                  activeView === 'users'
                    ? 'bg-[var(--secondary2-trans-100)] text-[var(--primary)]'
                    : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
                }`}
              >
                <Users className="w-5 h-5 shrink-0" />
                {!sidebarCollapsed && <span>User Profiles</span>}
              </button>
            )}

            {/* 8. Machine Management CRUD (Admin only) */}
            {sessionUser.role === 'Admin' && (
              <button
                onClick={() => { setActiveView('machine-admin'); setMobileSidebarOpen(false); }}
                className={`w-full flex items-center gap-4 px-4 py-3.5 rounded-xl text-sm font-black uppercase tracking-wider transition-all ${
                  activeView === 'machine-admin'
                    ? 'bg-[var(--secondary2-trans-100)] text-[var(--primary)]'
                    : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
                }`}
              >
                <Settings className="w-5 h-5 shrink-0" />
                {!sidebarCollapsed && <span>Machine Management</span>}
              </button>
            )}

            {/* 9. Audit Log (Admin only) */}
            {sessionUser.role === 'Admin' && (
              <button
                onClick={() => { setActiveView('audit'); setMobileSidebarOpen(false); }}
                className={`w-full flex items-center gap-4 px-4 py-3.5 rounded-xl text-sm font-black uppercase tracking-wider transition-all ${
                  activeView === 'audit'
                    ? 'bg-[var(--secondary2-trans-100)] text-[var(--primary)]'
                    : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
                }`}
              >
                <ShieldCheck className="w-5 h-5 shrink-0" />
                {!sidebarCollapsed && <span>Audit Log</span>}
              </button>
            )}
          </nav>
        </div>

        {/* Sidebar Footer */}
        <div className="p-4 border-t border-[var(--grey-200)] space-y-2.5 bg-[var(--white-color)]">
          {/* Theme Toggler */}
          <button
            onClick={() => setThemeMode((m) => (m === 'light' ? 'dark' : 'light'))}
            className="w-full flex items-center gap-4 px-4 py-3.5 rounded-xl text-xs font-bold text-slate-500 hover:bg-slate-100 transition-all"
          >
            {themeMode === 'light' ? <MoonStar className="w-5 h-5" /> : <SunMedium className="w-5 h-5" />}
            {!sidebarCollapsed && <span>{themeMode === 'light' ? 'Dark Mode' : 'Light Mode'}</span>}
          </button>

          {/* Logout Button */}
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-4 px-4 py-3.5 rounded-xl text-xs font-black text-rose-500 hover:bg-rose-50 hover:text-rose-700 transition-all uppercase tracking-wider"
          >
            <LogOut className="w-5 h-5 shrink-0" />
            {!sidebarCollapsed && <span>Logout</span>}
          </button>

          {/* Collapse toggle */}
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="absolute top-1/2 right-[-14px] -translate-y-1/2 w-7 h-7 rounded-full bg-[var(--white-color)] border border-[var(--grey-200)] flex items-center justify-center text-slate-400 hover:text-[var(--primary)] hover:border-[var(--primary)] shadow-sm cursor-pointer z-10 transition-all duration-300 hidden lg:flex"
          >
            {sidebarCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>
      </aside>

      {/* 2. MAIN PANEL */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Header */}
        <Header
          socketConnected={socketConnected}
          sessionUser={sessionUser}
          onToggleMobileSidebar={() => setMobileSidebarOpen(!mobileSidebarOpen)}
          alerts={alerts}
          onDismissAlert={(id) => setAlerts((prev) => prev.filter((a) => a.id !== id))}
          onClearAlerts={() => setAlerts([])}
        />

        {/* Main Body with generous spacing */}
        <main className="flex-1 p-8 space-y-8 overflow-y-auto">

          {!initialLoadComplete ? (
            <DashboardSkeleton />
          ) : (
          <>
          {/* VIEW CONDITIONAL SWITCH */}
          {activeView === 'overview' ? (
            // 1. Dashboard Overview Landing Page
            <div className="space-y-8 w-full animate-in fade-in duration-200 text-left">
              
              {/* Plant Head Operations Dashboard Card */}
              <div className="jbm-card p-6 border-l-4 border-l-[var(--primary)] bg-gradient-to-br from-[var(--white-color)] to-slate-50/50">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-[var(--grey-200)]">
                  <div className="flex items-center gap-3">
                    <Trophy className="w-6 h-6 text-[var(--primary)] shrink-0 animate-bounce" />
                    <div>
                      <h4 className="text-base font-black uppercase text-[var(--grey-900)] tracking-wide">JBM Rep Operations Overview</h4>
                      <p className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono">Daily Plant Operations Summary & Key Performance Indicators</p>
                    </div>
                  </div>
                  
                  <button
                    onClick={handleExportPlantHeadReport}
                    className="flex items-center gap-1.5 px-5 py-3 rounded-xl bg-[var(--primary)] hover:bg-[var(--primary)]/90 text-white font-extrabold text-xs uppercase tracking-wider shadow-sm transition active:scale-95 shrink-0"
                  >
                    <Download className="w-4 h-4" />
                    Export Executive CSV
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mt-6 select-none">
                  {/* KPI 1 */}
                  <div className="p-4 bg-[var(--bg-color-page)]/40 border border-[var(--grey-200)] rounded-2xl leading-snug">
                    <span className="text-xs font-black text-slate-400 uppercase tracking-wider">OEE Rating</span>
                    <div className="text-3xl font-black text-[var(--grey-900)] mt-1.5 flex items-baseline gap-2">
                      {averageOee.toFixed(1)}%
                      <span className={`text-xs font-bold px-2 py-0.5 rounded ${averageOee >= 85 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                        {averageOee >= 85 ? 'Class-A' : 'Class-B'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-2 font-bold">Target plant benchmark: 85%</p>
                  </div>

                  {/* KPI 2 */}
                  <div className="p-4 bg-[var(--bg-color-page)]/40 border border-[var(--grey-200)] rounded-2xl leading-snug">
                    <span className="text-xs font-black text-slate-400 uppercase tracking-wider">Loss Bottleneck Cause</span>
                    <div className="text-base font-black text-[var(--grey-900)] mt-2 truncate text-[var(--secondary)] flex items-center gap-1.5">
                      <Flame className="w-5 h-5 shrink-0 text-[var(--secondary)]" />
                      {calculateBottleneckReason()}
                    </div>
                    <p className="text-xs text-slate-400 mt-2 font-bold">Largest downtime cycle duration</p>
                  </div>

                  {/* KPI 3 */}
                  <div className="p-4 bg-[var(--bg-color-page)]/40 border border-[var(--grey-200)] rounded-2xl leading-snug">
                    <span className="text-xs font-black text-slate-400 uppercase tracking-wider">Quality Defect Alert</span>
                    <div className="text-3xl font-black text-[var(--grey-900)] mt-1.5 flex items-baseline gap-2">
                      {calculateTotalScrapRate()}%
                      <span className={`text-xs font-bold px-2 py-0.5 rounded ${parseFloat(calculateTotalScrapRate()) < 2.0 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                        {parseFloat(calculateTotalScrapRate()) < 2.0 ? 'Safe' : 'Exceeded'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-2 font-bold">Critical scrap threshold: &lt; 2.0%</p>
                  </div>

                  {/* KPI 4 */}
                  <div className="p-4 bg-[var(--bg-color-page)]/40 border border-[var(--grey-200)] rounded-2xl leading-snug">
                    <span className="text-xs font-black text-slate-400 uppercase tracking-wider">Asset Connected Ratio</span>
                    <div className="text-3xl font-black text-[var(--grey-900)] mt-1.5">
                      {((machines.filter(m => m.status !== 'No Signal').length / (machines.length || 1)) * 100).toFixed(1)}%
                    </div>
                    <p className="text-xs text-slate-400 mt-2 font-bold">Total active IoT nodes: {machines.filter(m => m.status !== 'No Signal').length}/{machines.length}</p>
                  </div>
                </div>
              </div>

              {/* 3 Summary Cards */}
              <SummaryBar machines={machines} />

              {/* Factory Status at a Glance Widget */}
              <div className="jbm-card p-6 text-left">
                <div className="flex items-center gap-2.5 pb-4 border-b border-[var(--grey-200)] mb-6">
                  <Cpu className="w-6 h-6 text-[var(--primary)] shrink-0" />
                  <div>
                    <h4 className="text-base font-black uppercase text-[var(--grey-900)] tracking-wide">Live Factory Load Map</h4>
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono">Current operational load of CNC shop floor</p>
                  </div>
                </div>
                
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-6 text-center text-sm font-bold">
                  <div className="p-4 bg-emerald-50 text-emerald-700 border border-emerald-100 rounded-2xl">
                    <span className="text-xs font-black uppercase tracking-wider block text-emerald-600">Running Machines</span>
                    <span className="text-2xl font-black block mt-1">{machines.filter(m => m.status === 'Running').length} / {machines.length}</span>
                  </div>
                  <div className="p-4 bg-rose-50 text-rose-700 border border-rose-100 rounded-2xl">
                    <span className="text-xs font-black uppercase tracking-wider block text-rose-600">Stopped Machines</span>
                    <span className="text-2xl font-black block mt-1">{machines.filter(m => m.status === 'Stopped').length} / {machines.length}</span>
                  </div>
                  <div className="p-4 bg-slate-50 text-slate-500 border border-slate-200 rounded-2xl">
                    <span className="text-xs font-black uppercase tracking-wider block text-slate-400">Offline Nodes</span>
                    <span className="text-2xl font-black block mt-1">{machines.filter(m => m.status === 'No Signal').length} / {machines.length}</span>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm border-collapse">
                    <thead>
                      <tr className="border-b border-[var(--grey-200)] text-slate-400 uppercase font-black text-[10px] tracking-wider">
                        <th className="py-3 px-2">Machine Unit</th>
                        <th className="py-3 px-3">Operator</th>
                        <th className="py-3 px-3">Active Part</th>
                        <th className="py-3 px-3 text-right">OEE Metric</th>
                        <th className="py-3 px-3 text-right">Yield Tally</th>
                        <th className="py-3 px-3 text-right">State</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
                      {machines.map(m => (
                        <tr key={m.id} className="hover:bg-slate-50 transition">
                          <td className="py-4.5 px-2">
                            <div className="text-[var(--grey-900)] font-black text-[15px]">{m.name}</div>
                            <div className="text-xs font-mono text-[var(--primary)] mt-1">{m.id}</div>
                          </td>
                          <td className="py-4.5 px-3 capitalize text-sm">{m.assigned_operator || 'Unassigned'}</td>
                          <td className="py-4.5 px-3 text-slate-400 text-sm">{m.active_part_name || 'Unassigned'}</td>
                          <td className="py-4.5 px-3 text-right">
                            <span className={`px-2.5 py-1 rounded text-xs font-black ${
                              (m.metrics?.oee || 0) >= 85 ? 'bg-emerald-50 text-emerald-700' :
                              (m.metrics?.oee || 0) >= 60 ? 'bg-amber-50 text-amber-700' :
                              'bg-rose-50 text-rose-700'
                            }`}>
                              {(m.metrics?.oee || 0)}%
                            </span>
                          </td>
                          <td className="py-4.5 px-3 text-right font-mono text-[13px] text-slate-800">
                            {m.good_count} / {m.production_count} <span className="text-[10px] text-slate-400 font-sans">({m.scrap_count} scrap)</span>
                          </td>
                          <td className="py-4.5 px-3 text-right">
                            <span className={`inline-flex items-center gap-1.5 text-xs uppercase font-bold ${
                              m.status === 'Running' ? 'text-emerald-600' :
                              m.status === 'Stopped' ? 'text-[var(--secondary)]' :
                              'text-slate-455'
                            }`}>
                              <span className={`w-2 h-2 rounded-full ${
                                m.status === 'Running' ? 'bg-emerald-500 animate-pulse' :
                                m.status === 'Stopped' ? 'bg-[var(--secondary)]' :
                                'bg-slate-400'
                              }`}></span>
                              {m.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

            </div>
          ) : activeView === 'machines' ? (
            // 2. Machine Status Cards Grid view: filters + categories + cards
            <div className="space-y-8 w-full animate-in fade-in duration-200">
              
              {/* Filters Row */}
              <div className="flex justify-between items-center bg-[var(--white-color)] border border-[var(--grey-200)] px-5 py-4 rounded-2xl shadow-sm flex-wrap gap-4 select-none text-left">
                <div className="flex items-center gap-3 flex-wrap text-xs font-bold text-slate-500">
                  <span className="text-xs font-black uppercase tracking-wider text-[var(--primary)] mr-3 flex items-center gap-1.5">
                    <SlidersHorizontal className="w-4 h-4" /> Filters:
                  </span>
                  <span className="flex items-center bg-[var(--bg-color-page)] px-4 py-1.5 rounded-lg border border-[var(--grey-200)]">
                    Plant: <strong className="text-[var(--grey-900)] ml-1">JBM REP</strong>
                  </span>
                  <span className="flex items-center bg-[var(--bg-color-page)] px-4 py-1.5 rounded-lg border border-[var(--grey-200)]">
                    Machine: <strong className="text-[var(--grey-900)] ml-1">{machineFilter.replace('All Machines', 'All')}</strong>
                  </span>
                  <span className="flex items-center bg-[var(--bg-color-page)] px-4 py-1.5 rounded-lg border border-[var(--grey-200)]">
                    Date: <strong className="text-[var(--grey-900)] ml-1">{dateFilter || 'Today'}</strong>
                  </span>
                  <span className="flex items-center bg-[var(--bg-color-page)] px-4 py-1.5 rounded-lg border border-[var(--grey-200)]">
                    Shift: <strong className="text-[var(--grey-900)] ml-1">{shiftFilter.replace('All Shifts', 'All')}</strong>
                  </span>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={openFilterModal}
                    className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-[var(--primary)] hover:bg-[var(--primary)]/90 text-white font-extrabold text-xs uppercase tracking-wider shadow-sm transition active:scale-95"
                  >
                    <Filter className="w-4 h-4" />
                    Filter Dialog
                  </button>
                  {(searchTerm || statusFilter !== 'All' || shiftFilter !== 'All Shifts' || machineFilter !== 'All Machines' || dateFilter) && (
                    <button
                      onClick={resetFilters}
                      className="px-4 py-2.5 rounded-xl border border-slate-200 bg-[var(--bg-color-page)] text-slate-500 hover:text-slate-800 text-xs font-black uppercase tracking-wider transition"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>

              {/* Metric tabs and Machine Buttons Row */}
              <div className="jbm-card overflow-hidden">
                {/* Metric Tabs */}
                <div className="flex border-b border-[var(--grey-200)] bg-[var(--bg-color-page)]/40 overflow-x-auto scrollbar">
                  {['OEE', 'Downtime', 'Production', 'Production Rate', 'Quality', 'Utilization'].map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setActiveMetricTab(tab)}
                      className={`px-8 py-4 text-xs font-black uppercase tracking-wider transition-all border-b-[2.5px] ${
                        activeMetricTab === tab
                          ? 'border-[var(--primary)] text-[var(--primary)] bg-[var(--white-color)]'
                          : 'border-transparent text-slate-400 hover:text-slate-700 bg-transparent'
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                {/* Machines Horizontal buttons list */}
                <div className="p-5 flex gap-3 overflow-x-auto scrollbar select-none">
                  <button
                    onClick={() => setMachineFilter('All Machines')}
                    className={`px-5 py-2.5 rounded-xl text-xs font-black uppercase transition ${
                      machineFilter === 'All Machines'
                        ? 'bg-[var(--primary)] text-white'
                        : 'bg-[var(--secondary2-trans-100)] text-[var(--primary)] hover:bg-[var(--secondary2-trans)]'
                    }`}
                  >
                    All Machines
                  </button>
                  {machines.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setMachineFilter(m.id)}
                      className={`px-5 py-2.5 rounded-xl text-xs font-black uppercase transition shrink-0 ${
                        machineFilter === m.id
                          ? 'bg-[var(--primary)] text-white'
                          : 'bg-[var(--secondary2-trans-100)] text-[var(--primary)] hover:bg-[var(--secondary2-trans)]'
                      }`}
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Machine Cards grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {filteredMachines.length > 0 ? (
                  filteredMachines.map((machine) => (
                    <MachineCard
                      key={machine.id}
                      machine={machine}
                      history={histories[machine.id] || []}
                    />
                  ))
                ) : (
                  <div className="col-span-full py-24 text-center text-slate-450 font-black uppercase tracking-widest bg-[var(--white-color)] border border-[var(--grey-200)] rounded-2xl shadow-sm select-none">
                    No machines match the plant filter selection.
                  </div>
                )}
              </div>

            </div>
          ) : activeView === 'analytics' ? (
            // 3. Analytics charts separated to prevent visual clutter
            <div className="space-y-8 w-full animate-in fade-in duration-200">
              {filteredMachines.length > 0 ? (
                <Suspense fallback={<ViewLoadingFallback />}>
                  <AnalyticsCharts machines={filteredMachines} reasonCodes={reasonCodes} />
                </Suspense>
              ) : (
                <div className="py-24 text-center text-slate-400 font-bold uppercase tracking-widest bg-[var(--white-color)] border border-[var(--grey-200)] rounded-2xl">
                  No active machines found to chart.
                </div>
              )}
            </div>
          ) : activeView === 'planning' ? (
            // 4. Dated shift planning calendar (PPC scheduling, history, target-vs-actual, Excel export)
            <div className="w-full animate-in fade-in duration-200 text-left">
              <Suspense fallback={<ViewLoadingFallback />}>
                <ShiftPlanningCalendar
                  authToken={authToken}
                  machines={machines}
                  sessionUser={sessionUser}
                  onAuthError={handleAuthError}
                />
              </Suspense>
            </div>
          ) : activeView === 'reports' ? (
            // 5. Historical logs and download reports view
            <div className="space-y-8 w-full animate-in fade-in duration-200 text-left">
              <div className="relative">
                <div className="absolute top-4 right-4 z-10 flex gap-2 flex-wrap">
                  <button
                    onClick={handleExportDowntime}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-[var(--white-color)] hover:border-[var(--primary)] text-[10px] font-black uppercase tracking-wider text-slate-600 transition shadow-sm"
                  >
                    <Download className="w-3 h-3 text-[var(--primary)]" /> Export Downtime CSV
                  </button>
                  <button
                    onClick={handleExportProduction}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-[var(--white-color)] hover:border-[var(--primary)] text-[10px] font-black uppercase tracking-wider text-slate-600 transition shadow-sm"
                  >
                    <Download className="w-3 h-3 text-[var(--primary)]" /> Export OEE Performance
                  </button>
                </div>
                <Suspense fallback={<ViewLoadingFallback />}>
                  <ReportsLog reports={filteredReports} machines={machines} currentUser={sessionUser} onRefresh={fetchReports} />
                </Suspense>
              </div>
            </div>
          ) : activeView === 'users' ? (
            // 6. User Profiles CRUD Manager (Admin Only)
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in duration-200 text-left">
              
              {/* CRUD Form Column */}
              <div className="jbm-card p-6 h-fit flex flex-col gap-5">
                <div className="flex items-center gap-2 pb-3 border-b border-[var(--grey-200)]">
                  <UserPlus className="w-5 h-5 text-[var(--primary)]" />
                  <h3 className="text-sm font-black text-[var(--grey-900)] uppercase tracking-wider">
                    {crudEditing ? 'Modify Profile' : 'Register Profile'}
                  </h3>
                </div>

                <form onSubmit={crudEditing ? handleUpdateUser : handleAddUser} className="space-y-4">
                  <div>
                    <label className="block text-[11px] font-black uppercase tracking-wider text-slate-455 mb-1.5">Login ID Badge</label>
                    <input
                      type="text"
                      disabled={crudEditing}
                      value={crudLoginId}
                      onChange={(e) => setCrudLoginId(e.target.value.trim().toUpperCase())}
                      placeholder="e.g. OP-105, SUP-205"
                      className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] disabled:opacity-50 text-[var(--grey-900)] rounded-xl py-3 px-3 text-xs font-bold outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-black uppercase tracking-wider text-slate-455 mb-1.5">Personnel Full Name</label>
                    <input
                      type="text"
                      value={crudDisplayName}
                      onChange={(e) => setCrudDisplayName(e.target.value)}
                      placeholder="Enter display name"
                      className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] text-[var(--grey-900)] rounded-xl py-3 px-3 text-xs font-bold outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-black uppercase tracking-wider text-slate-455 mb-1.5">Access Role Permission</label>
                    <select
                      value={crudRole}
                      onChange={(e) => setCrudRole(e.target.value)}
                      className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] text-[var(--grey-900)] rounded-xl py-3 px-3 text-xs font-bold outline-none"
                    >
                      {ROLE_OPTIONS.map(role => <option key={role} value={role}>{role}</option>)}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-black uppercase tracking-wider text-slate-455 mb-1.5">Terminal Layout</label>
                    <select
                      value={crudTerminalId}
                      onChange={(e) => setCrudTerminalId(e.target.value)}
                      className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] text-[var(--grey-900)] rounded-xl py-3 px-3 text-xs font-bold outline-none"
                    >
                      <option value="DASHBOARD">Dashboard Overview</option>
                      <option value="PLANNING-BOARD">Planning Console</option>
                      <option value="CONTROL-ROOM">Control Room Panel</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-black uppercase tracking-wider text-slate-455 mb-1.5">
                      Password {crudEditing && <span className="normal-case font-semibold text-slate-400">(leave blank to keep current)</span>}
                    </label>
                    <input
                      type="password"
                      value={crudPassword}
                      onChange={(e) => setCrudPassword(e.target.value)}
                      placeholder={crudEditing ? 'New password (optional)' : 'Set initial password'}
                      className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] text-[var(--grey-900)] rounded-xl py-3 px-3 text-xs font-bold outline-none"
                    />
                  </div>

                  {crudSuccessMsg && (
                    <div className="bg-emerald-50 text-emerald-700 text-xs font-bold px-3 py-2 rounded-xl border border-emerald-100 uppercase tracking-wider">
                      {crudSuccessMsg}
                    </div>
                  )}

                  {crudErrorMsg && (
                    <div className="bg-rose-50 text-rose-700 text-xs font-bold px-3 py-2 rounded-xl border border-rose-100 uppercase tracking-wider">
                      {crudErrorMsg}
                    </div>
                  )}

                  <div className="flex gap-2">
                    {crudEditing && (
                      <button
                        type="button"
                        onClick={() => {
                          setCrudEditing(false);
                          setCrudLoginId('');
                          setCrudDisplayName('');
                          setCrudPassword('');
                        }}
                        className="flex-1 py-2.5 px-3 rounded-xl border border-slate-200 text-slate-500 font-extrabold text-xs uppercase tracking-wider hover:bg-slate-50"
                      >
                        Cancel
                      </button>
                    )}
                    <button
                      type="submit"
                      className="flex-1 py-2.5 px-3 rounded-xl bg-[var(--primary)] hover:bg-[var(--primary)]/90 text-white font-extrabold text-xs uppercase tracking-wider shadow-sm transition active:scale-95"
                    >
                      {crudEditing ? 'Save Changes' : 'Register Profile'}
                    </button>
                  </div>
                </form>
              </div>

              {/* CRUD Table list column */}
              <div className="lg:col-span-2 jbm-card p-6 flex flex-col gap-5">
                <div className="flex items-center gap-2 pb-3 border-b border-[var(--grey-200)]">
                  <UserCheck className="w-5 h-5 text-[var(--primary)] animate-pulse" />
                  <h3 className="text-sm font-black text-[var(--grey-900)] uppercase tracking-wider">
                    Authorized Plant Accounts List
                  </h3>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm border-collapse">
                    <thead>
                      <tr className="border-b border-[var(--grey-200)] text-slate-400 uppercase font-black text-[10px] tracking-wider">
                        <th className="py-3 px-2">Badge ID</th>
                        <th className="py-3 px-2">Name</th>
                        <th className="py-3 px-2">Role</th>
                        <th className="py-3 px-2">Terminal Layout</th>
                        <th className="py-3 px-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-semibold text-slate-700 bg-white">
                      {accounts.map(acc => (
                        <tr key={acc.loginId} className="hover:bg-slate-50 transition">
                          <td className="py-4 px-2 font-mono text-[var(--primary)] text-sm">{acc.loginId}</td>
                          <td className="py-4 px-2 text-[var(--grey-900)] text-sm">{acc.displayName}</td>
                          <td className="py-4 px-2 text-xs">
                            <span className={`px-2.5 py-1 rounded-full font-black uppercase ${
                              acc.role === 'Admin' ? 'bg-rose-50 text-rose-700' :
                              acc.role === 'PPC Engineer' ? 'bg-indigo-50 text-indigo-700' :
                              acc.role === 'Supervisor' ? 'bg-blue-50 text-blue-700' :
                              'bg-slate-100 text-slate-655'
                            }`}>
                              {acc.role}
                            </span>
                          </td>
                          <td className="py-4 px-2 text-xs text-slate-400 font-mono">{acc.terminalId}</td>
                          <td className="py-4 px-2 text-right space-x-2">
                            <button
                              onClick={() => editUserSetup(acc)}
                              className="text-xs font-black uppercase text-[var(--primary)] hover:underline"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleDeleteUser(acc.loginId)}
                              disabled={acc.loginId === 'ADMIN'}
                              className="text-xs font-black uppercase text-rose-500 hover:underline disabled:opacity-30 disabled:no-underline"
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

            </div>
          ) : activeView === 'machine-admin' ? (
            // 7. Machine Management (Admin only)
            <div className="animate-in fade-in duration-200 text-left">
              <MachineManagement
                machines={machines}
                authToken={authToken}
                onRefresh={loadInitialData}
                onAuthError={handleAuthError}
              />
            </div>
          ) : activeView === 'audit' ? (
            // 8. Audit Log (Admin only)
            <div className="animate-in fade-in duration-200 text-left">
              <AuditLogView entries={auditLog} onRefresh={fetchAuditLog} />
            </div>
          ) : (
            // 9. Operator terminal layout view
            <div className="space-y-4 animate-in fade-in duration-200 w-full text-left">
              <div className="jbm-card p-5 bg-gradient-to-r from-[var(--primary)] to-indigo-700 text-white shadow-lg border-none flex flex-col md:flex-row md:items-center justify-between gap-4 select-none">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.45em] text-blue-100">Simulate PLC telemetry</p>
                  <h3 className="text-lg font-black uppercase mt-1">One-Pulse-Per-Cycle Touch Terminal</h3>
                  <p className="text-xs text-blue-50/80 mt-1 max-w-2xl leading-relaxed">
                    Trigger production pulses manually to simulate telemetry. In production, this data is streamed automatically via MQTT and hardware IO relays.
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="px-3 py-1 rounded-lg border border-white/20 bg-white/10 text-[9px] font-black uppercase tracking-widest font-mono">
                    {operatingMode}
                  </span>
                  <span className="px-3 py-1 rounded-lg border border-white/20 bg-white/10 text-[9px] font-black uppercase tracking-widest font-mono">
                    {socketConnected ? 'MQTT Telemetry Connected' : 'Telemetry Reconnecting...'}
                  </span>
                </div>
              </div>

              <OperatorTerminal
                machines={machines}
                onStopMachine={handleStopMachine}
                onResumeMachine={handleResumeMachine}
                operatingMode={operatingMode}
                sessionUser={sessionUser}
                reasonCodes={reasonCodes}
              />
            </div>
          )}
          </>
          )}

        </main>
      </div>

      {/* 3. FILTER MODAL/DIALOG */}
      {filterModalOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex justify-end z-50 animate-in fade-in duration-200 select-none">
          <div className="w-full max-w-[400px] bg-[var(--white-color)] h-full shadow-2xl flex flex-col justify-between border-l border-[var(--grey-200)] animate-in slide-in-from-right duration-350">
            
            {/* Modal Header */}
            <div className="flex items-center justify-between p-5 border-b border-[var(--grey-200)]">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-[var(--primary)]" />
                <h5 className="font-black text-sm uppercase tracking-wider text-[var(--grey-900)]">Filter Options</h5>
              </div>
              <button
                onClick={() => setFilterModalOpen(false)}
                className="w-8 h-8 rounded-xl bg-slate-50 border border-slate-200 hover:border-slate-350 flex items-center justify-center text-slate-500 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body without departments */}
            <div className="flex-1 p-6 overflow-y-auto space-y-6 text-left">
              <div>
                <label className="block text-xs font-black uppercase tracking-wider text-slate-455 mb-1.5">Machine Unit</label>
                <select
                  value={tempMachine}
                  onChange={(e) => setTempMachine(e.target.value)}
                  className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-sm font-bold outline-none uppercase text-slate-700"
                >
                  <option value="All Machines">All Machines</option>
                  {machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.id} - {machine.name}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-xs font-black uppercase tracking-wider text-slate-455 mb-1.5">Date Range</label>
                <input
                  type="date"
                  value={tempDate}
                  onChange={(e) => setTempDate(e.target.value)}
                  className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-sm font-bold outline-none text-slate-700"
                />
              </div>

              <div>
                <label className="block text-xs font-black uppercase tracking-wider text-slate-455 mb-1.5">Active Shift</label>
                <select
                  value={tempShift}
                  onChange={(e) => setTempShift(e.target.value)}
                  className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-sm font-bold outline-none uppercase text-slate-700"
                >
                  {SHIFT_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-xs font-black uppercase tracking-wider text-slate-455 mb-1.5">Status Filter</label>
                <select
                  value={tempStatus}
                  onChange={(e) => setTempStatus(e.target.value)}
                  className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-sm font-bold outline-none uppercase text-slate-700"
                >
                  {STATUS_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-5 border-t border-[var(--grey-200)] bg-[var(--bg-color-page)]/40 flex justify-between gap-3">
              <button
                onClick={resetFilters}
                className="flex-1 py-2.5 rounded-xl border border-slate-200 bg-[var(--white-color)] hover:bg-slate-100 text-slate-500 font-extrabold text-xs uppercase tracking-wider transition"
              >
                Reset All
              </button>
              <button
                onClick={applyFilters}
                className="flex-1 py-2.5 rounded-xl bg-[var(--primary)] hover:bg-[var(--primary)]/90 text-white font-extrabold text-xs uppercase tracking-wider transition shadow-md active:scale-95"
              >
                Apply Filters
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Delete User Confirmation Dialog (replaces browser confirm()) */}
      {pendingDeleteLoginId && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-[var(--white-color)] rounded-2xl border border-[var(--grey-200)] shadow-2xl w-full max-w-sm p-6 text-left">
            <h4 className="text-sm font-black uppercase tracking-wider text-[var(--grey-900)]">Delete User Profile?</h4>
            <p className="text-sm text-slate-500 mt-2">
              This will permanently remove <strong className="text-[var(--grey-900)]">{pendingDeleteLoginId}</strong>. This action cannot be undone.
            </p>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setPendingDeleteLoginId(null)}
                className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-500 font-extrabold text-xs uppercase tracking-wider hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteUser}
                className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-xs uppercase tracking-wider shadow-sm transition active:scale-95"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppShell />
    </ToastProvider>
  );
}
