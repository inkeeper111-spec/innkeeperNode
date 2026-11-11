import { Router } from 'express';
import { authenticate, requireTenant, authorize } from '../middlewares/auth.js';
import { ROLES } from '../config/constants.js';
import { uploadExcel } from '../middlewares/upload.js';

import {
  getGlobalConfiguration,
  upsertGlobalConfiguration,
  getCutoffWindow
} from '../controllers/payroll/globalConfigController.js';
import {
  getStaffTaxConfig,
  upsertStaffTaxConfig
} from '../controllers/payroll/taxConfigController.js';
import {
  listWeekoffCategories,
  createWeekoffCategory,
  updateWeekoffCategory,
  deleteWeekoffCategory
} from '../controllers/payroll/weekoffController.js';
import {
  listHolidays,
  createHoliday,
  updateHoliday,
  deleteHoliday,
  exportHolidayTemplate,
  uploadHolidayExcel,
  viewHolidayBulkUploadLogs
} from '../controllers/payroll/holidayController.js';
import {
  getLeaveConfig,
  upsertLeaveConfig,
  getStaffLeaveUsage
} from '../controllers/payroll/leaveConfigController.js';
import {
  getStaffSalaryData,
  addStaffSalary,
  updateStaffSalary,
  exportStaffTemplate,
  uploadStaffSalaryExcel,
  viewBulkUploadLogs,
  getPayrollStaffData
} from '../controllers/payroll/staffSalaryController.js';
import {
  getAttendanceData,
  getAttendanceList,
  updateAttendanceData,
  weekoffUpdation
} from '../controllers/payroll/attendanceController.js';
import {
  listAdvances,
  createAdvance,
  updateAdvance,
  deleteAdvance
} from '../controllers/payroll/advanceController.js';
import {
  monthlyPayrollProcess,
  getPayrollDetails,
  getPayrollByStaff,
  updatePayrollPeriodStatus,
  previousSixMonthData,
  getPayrollExportConfig,
  upsertPayrollExportConfig,
  downloadPayrollExcel,
  downloadPayrollExcelFullStructure,
  downloadPayslip,
  getDashboardPayroll
} from '../controllers/payroll/payrollRunController.js';

const router = Router();
const admin = authorize(ROLES.HOTEL_ADMIN);

router.use(authenticate);
router.use(requireTenant);

// Global configuration
router.get('/global-configuration', admin, getGlobalConfiguration);
router.put('/global-configuration', admin, upsertGlobalConfiguration);
router.get('/cutoff', admin, getCutoffWindow);

// Statutory / tax
router.get('/tax-config', admin, getStaffTaxConfig);
router.put('/tax-config', admin, upsertStaffTaxConfig);
router.post('/tax-config', admin, upsertStaffTaxConfig);

// Week-off
router.get('/weekoff-categories', admin, listWeekoffCategories);
router.post('/weekoff-categories', admin, createWeekoffCategory);
router.put('/weekoff-categories/:id', admin, updateWeekoffCategory);
router.delete('/weekoff-categories/:id', admin, deleteWeekoffCategory);

// Holidays
router.get('/holidays', admin, listHolidays);
router.post('/holidays', admin, createHoliday);
router.put('/holidays/:id', admin, updateHoliday);
router.delete('/holidays/:id', admin, deleteHoliday);
router.get('/holidays/template', admin, exportHolidayTemplate);
router.post('/holidays/upload', admin, uploadExcel.single('file'), uploadHolidayExcel);
router.get('/holidays/upload-logs', admin, viewHolidayBulkUploadLogs);

// Leave config
router.get('/leave-config', admin, getLeaveConfig);
router.post('/leave-config', admin, upsertLeaveConfig);
router.put('/leave-config', admin, upsertLeaveConfig);
router.get('/leave-usage', admin, getStaffLeaveUsage);

// Staff salary
router.post('/staff-salary/list', admin, getStaffSalaryData);
router.get('/staff-salary', admin, getStaffSalaryData);
router.post('/staff-salary', admin, addStaffSalary);
router.put('/staff-salary/:id', admin, updateStaffSalary);
router.get('/staff-salary/template', admin, exportStaffTemplate);
router.post('/staff-salary/upload', admin, uploadExcel.single('file'), uploadStaffSalaryExcel);
router.get('/staff-salary/upload-logs', admin, viewBulkUploadLogs);
router.get('/staff-data', admin, getPayrollStaffData);

// Attendance (payroll calendar)
router.get('/attendance/list', admin, getAttendanceList);
router.get('/attendance', admin, getAttendanceData);
router.post('/attendance', admin, getAttendanceData);
router.put('/attendance', admin, updateAttendanceData);
router.post('/attendance/update', admin, updateAttendanceData);
router.post('/weekoff-updation', admin, weekoffUpdation);

// Advances
router.get('/advances', admin, listAdvances);
router.post('/advances', admin, createAdvance);
router.put('/advances/:id', admin, updateAdvance);
router.delete('/advances/:id', admin, deleteAdvance);

// Payroll run
router.post('/run', admin, monthlyPayrollProcess);
router.get('/details', admin, getPayrollDetails);
router.get('/by-staff', admin, getPayrollByStaff);
router.post('/period-status', admin, updatePayrollPeriodStatus);
router.get('/previous-six-months', admin, previousSixMonthData);
router.get('/dashboard', admin, getDashboardPayroll);

// Export config + downloads
router.get('/export-config', admin, getPayrollExportConfig);
router.post('/export-config', admin, upsertPayrollExportConfig);
router.put('/export-config', admin, upsertPayrollExportConfig);
router.post('/download-excel', admin, downloadPayrollExcel);
router.post('/download-excel-full', admin, downloadPayrollExcelFullStructure);
router.get('/payslip', admin, downloadPayslip);

export default router;
