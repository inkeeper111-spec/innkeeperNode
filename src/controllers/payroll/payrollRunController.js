import dayjs from 'dayjs';
import ejs from 'ejs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import puppeteer from 'puppeteer';
import { MonthlyPayroll } from '../../models/MonthlyPayroll.js';
import { StaffSalary } from '../../models/StaffSalary.js';
import { StaffProfile } from '../../models/StaffProfile.js';
import { Hotel } from '../../models/Hotel.js';
import {
  PayrollExportConfig,
  DEFAULT_EXPORT_FIELDS
} from '../../models/PayrollExportConfig.js';
import { runMonthlyPayroll, getPreviousSixMonthData } from '../../services/payroll/payrollProcess.js';
import { getCutoffStatus } from '../../services/payroll/cutoff.js';
import { SalaryAttendance } from '../../models/SalaryAttendance.js';
import { summarizeAttendance } from '../../services/payroll/weekoffBuilder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const monthlyPayrollProcess = async (req, res, next) => {
  try {
    const { monthYear } = req.body;
    if (!monthYear) {
      return res.status(400).json({ success: false, message: 'monthYear is required.' });
    }
    const result = await runMonthlyPayroll({
      hotelId: req.hotelId,
      monthYear,
      userId: req.user._id
    });
    res.json({
      success: true,
      message: `Payroll processed for ${result.processed} staff.`,
      data: result
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        message: err.message,
        code: err.code
      });
    }
    next(err);
  }
};

export const getPayrollDetails = async (req, res, next) => {
  try {
    const { monthYear } = req.query;
    if (!monthYear) {
      return res.status(400).json({ success: false, message: 'monthYear is required.' });
    }
    const cutoff = await getCutoffStatus(req.hotelId, monthYear, 'payroll');
    const period = await MonthlyPayroll.findOne({
      hotelId: req.hotelId,
      monthYear,
      isPeriodConfig: true
    });
    const records = await MonthlyPayroll.find({
      hotelId: req.hotelId,
      monthYear,
      isPeriodConfig: false
    })
      .populate('staffId')
      .populate('userId', 'name email');

    res.json({
      success: true,
      data: {
        monthYear,
        periodStatus: period?.payrollPeriodStatus || 'active',
        cutoff,
        records,
        summary: {
          staffCount: records.length,
          totalGross: records.reduce((s, r) => s + (r.grossSalary || 0), 0),
          totalNet: records.reduce((s, r) => s + (r.netSalary || 0), 0),
          totalPf: records.reduce((s, r) => s + (r.pf || 0), 0),
          totalEsi: records.reduce((s, r) => s + (r.esi || 0), 0),
          totalAdvance: records.reduce((s, r) => s + (r.advancePayment || 0), 0)
        }
      }
    });
  } catch (err) {
    next(err);
  }
};

export const getPayrollByStaff = async (req, res, next) => {
  try {
    const { staffId, monthYear } = req.query;
    const filter = { hotelId: req.hotelId, isPeriodConfig: false };
    if (staffId) filter.staffId = staffId;
    if (monthYear) filter.monthYear = monthYear;
    const data = await MonthlyPayroll.find(filter)
      .populate('staffId')
      .populate('userId', 'name email')
      .sort({ monthYear: -1 });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const updatePayrollPeriodStatus = async (req, res, next) => {
  try {
    const { monthYear, payrollPeriodStatus } = req.body;
    if (!monthYear || !['active', 'inactive'].includes(payrollPeriodStatus)) {
      return res.status(400).json({
        success: false,
        message: 'monthYear and payrollPeriodStatus (active|inactive) required.'
      });
    }
    const period = await MonthlyPayroll.findOneAndUpdate(
      { hotelId: req.hotelId, monthYear, isPeriodConfig: true },
      {
        hotelId: req.hotelId,
        staffId: req.hotelId,
        userId: req.hotelId,
        monthYear,
        isPeriodConfig: true,
        payrollPeriodStatus,
        netSalary: 0,
        grossSalary: 0
      },
      { upsert: true, new: true }
    );
    res.json({ success: true, message: 'Period status updated.', data: period });
  } catch (err) {
    next(err);
  }
};

export const previousSixMonthData = async (req, res, next) => {
  try {
    const data = await getPreviousSixMonthData(req.hotelId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getPayrollExportConfig = async (req, res, next) => {
  try {
    let config = await PayrollExportConfig.findOne({ hotelId: req.hotelId });
    if (!config) {
      config = await PayrollExportConfig.create({
        hotelId: req.hotelId,
        fields: DEFAULT_EXPORT_FIELDS,
        fileType: 'excel',
        isWithoutHeader: false
      });
    }
    res.json({ success: true, data: config });
  } catch (err) {
    next(err);
  }
};

export const upsertPayrollExportConfig = async (req, res, next) => {
  try {
    const config = await PayrollExportConfig.findOneAndUpdate(
      { hotelId: req.hotelId },
      {
        hotelId: req.hotelId,
        fields: req.body.fields || DEFAULT_EXPORT_FIELDS,
        fileType: req.body.fileType || 'excel',
        format: req.body.format || 'standard',
        isWithoutHeader: !!req.body.isWithoutHeader
      },
      { upsert: true, new: true }
    );
    res.json({ success: true, message: 'Export configuration saved.', data: config });
  } catch (err) {
    next(err);
  }
};

async function buildExportRows(hotelId, monthYear) {
  const records = await MonthlyPayroll.find({
    hotelId,
    monthYear,
    isPeriodConfig: false
  })
    .populate('staffId')
    .populate('userId', 'name email');

  const salaries = await StaffSalary.find({ hotelId });
  const salByStaff = new Map(salaries.map((s) => [String(s.staffId), s]));

  return records.map((r) => {
    const sal = salByStaff.get(String(r.staffId?._id || r.staffId));
    return {
      employeeId: r.staffId?.employeeId || '',
      name: r.userId?.name || '',
      monthYear: r.monthYear,
      present: r.present,
      leave: r.leave,
      lop: r.lop,
      weekOff: r.weekOff,
      holiday: r.holiday,
      grossSalary: r.grossSalary,
      basicSalary: r.basicSalary,
      allowanceSalary: r.allowanceSalary,
      pf: r.pf,
      esi: r.esi,
      professionTax: r.professionTax,
      advancePayment: r.advancePayment,
      netSalary: r.netSalary,
      accountNo: sal?.bank?.accountNo || '',
      IFSC: sal?.bank?.IFSC || '',
      accountName: sal?.bank?.accountName || '',
      earnings: r.earnings,
      deductions: r.deductions,
      leaveDeduction: r.leaveDeduction
    };
  });
}

export const downloadPayrollExcel = async (req, res, next) => {
  try {
    const { monthYear } = req.body;
    if (!monthYear) {
      return res.status(400).json({ success: false, message: 'monthYear is required.' });
    }
    let config = await PayrollExportConfig.findOne({ hotelId: req.hotelId });
    if (!config) {
      config = { fields: DEFAULT_EXPORT_FIELDS, fileType: 'excel', isWithoutHeader: false };
    }
    const rows = await buildExportRows(req.hotelId, monthYear);
    const fields = (config.fields || DEFAULT_EXPORT_FIELDS)
      .filter((f) => f.isActive !== false)
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    if (config.fileType === 'txt') {
      const lines = [];
      if (!config.isWithoutHeader) lines.push(fields.map((f) => f.label).join('\t'));
      for (const row of rows) {
        lines.push(fields.map((f) => row[f.key] ?? '').join('\t'));
      }
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename=payroll-${monthYear}.txt`);
      return res.send(lines.join('\n'));
    }

    if (config.fileType === 'pdf') {
      const html = `
        <html><head><style>
          body{font-family:Arial;font-size:11px}
          table{border-collapse:collapse;width:100%}
          th,td{border:1px solid #ccc;padding:4px;text-align:left}
        </style></head><body>
        <h2>Payroll Register ${monthYear}</h2>
        <table>
          <thead><tr>${fields.map((f) => `<th>${f.label}</th>`).join('')}</tr></thead>
          <tbody>
            ${rows.map((row) => `<tr>${fields.map((f) => `<td>${row[f.key] ?? ''}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table></body></html>`;
      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdf = await page.pdf({ format: 'A4', landscape: true, printBackground: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=payroll-${monthYear}.pdf`);
        return res.send(Buffer.from(pdf));
      } finally {
        await browser.close();
      }
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Payroll');
    ws.columns = fields.map((f) => ({ header: f.label, key: f.key, width: 14 }));
    if (config.isWithoutHeader) {
      ws.spliceRows(1, 1);
    }
    rows.forEach((row) => ws.addRow(row));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=payroll-${monthYear}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
};

export const downloadPayrollExcelFullStructure = async (req, res, next) => {
  try {
    const { monthYear } = req.body;
    if (!monthYear) {
      return res.status(400).json({ success: false, message: 'monthYear is required.' });
    }
    const rows = await buildExportRows(req.hotelId, monthYear);
    const earningTypes = [...new Set(rows.flatMap((r) => (r.earnings || []).map((e) => e.type)))];
    const deductionTypes = [...new Set(rows.flatMap((r) => (r.deductions || []).map((d) => d.type)))];

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Full Payroll');
    const baseHeaders = [
      'Employee ID', 'Name', 'Month', 'Present', 'Leave', 'LOP', 'Week Off', 'Holiday',
      'Gross', 'Basic', 'Allowances', ...earningTypes.map((t) => `Earning:${t}`),
      'Leave Deduction', 'PF', 'ESI', 'Profession Tax',
      ...deductionTypes.map((t) => `Deduction:${t}`),
      'Advance', 'Net Salary', 'Account Name', 'Account No', 'IFSC'
    ];
    ws.addRow(baseHeaders);

    for (const r of rows) {
      const earnMap = Object.fromEntries((r.earnings || []).map((e) => [e.type, e.amount]));
      const dedMap = Object.fromEntries((r.deductions || []).map((d) => [d.type, d.amount]));
      ws.addRow([
        r.employeeId, r.name, r.monthYear, r.present, r.leave, r.lop, r.weekOff, r.holiday,
        r.grossSalary, r.basicSalary, r.allowanceSalary,
        ...earningTypes.map((t) => earnMap[t] || 0),
        r.leaveDeduction, r.pf, r.esi, r.professionTax,
        ...deductionTypes.map((t) => dedMap[t] || 0),
        r.advancePayment, r.netSalary, r.accountName, r.accountNo, r.IFSC
      ]);
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=payroll-full-${monthYear}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
};

export const downloadPayslip = async (req, res, next) => {
  try {
    const { staffId, monthYear } = req.query;
    if (!staffId || !monthYear) {
      return res.status(400).json({ success: false, message: 'staffId and monthYear are required.' });
    }

    const record = await MonthlyPayroll.findOne({
      hotelId: req.hotelId,
      staffId,
      monthYear,
      isPeriodConfig: false
    })
      .populate('staffId')
      .populate('userId', 'name email phone');

    if (!record) {
      return res.status(404).json({ success: false, message: 'Payslip not found. Run payroll first.' });
    }

    const hotel = await Hotel.findById(req.hotelId);
    const salary = await StaffSalary.findOne({ hotelId: req.hotelId, staffId });
    const templatePath = path.join(__dirname, '../../templates/payslip.ejs');

    const html = await ejs.renderFile(templatePath, {
      hotel,
      record: record.toObject(),
      staff: record.staffId,
      user: record.userId,
      bank: salary?.bank || {},
      monthLabel: dayjs(`${monthYear}-01`).format('MMMM YYYY')
    });

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdf = await page.pdf({ format: 'A4', printBackground: true });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename=payslip-${record.staffId?.employeeId || staffId}-${monthYear}.pdf`
      );
      res.send(Buffer.from(pdf));
    } finally {
      await browser.close();
    }
  } catch (err) {
    next(err);
  }
};

export const getDashboardPayroll = async (req, res, next) => {
  try {
    const six = await getPreviousSixMonthData(req.hotelId);
    const prevMonth = dayjs().subtract(1, 'month').format('YYYY-MM');
    const cutoff = await getCutoffStatus(req.hotelId, prevMonth, 'payroll');
    const records = await MonthlyPayroll.find({
      hotelId: req.hotelId,
      monthYear: prevMonth,
      isPeriodConfig: false
    });
    const profiles = await StaffProfile.countDocuments({
      hotelId: req.hotelId,
      status: { $ne: 'terminated' }
    });

    const start = dayjs(`${prevMonth}-01`).startOf('month');
    const attRows = await SalaryAttendance.find({
      hotelId: req.hotelId,
      attendanceDate: { $gte: start.toDate(), $lte: start.endOf('month').toDate() }
    });
    const present = attRows.filter((r) => r.status === 'P').length;
    const absent = attRows.filter((r) => r.status === 'L' || r.status === 'A').length;
    const leave = attRows.filter((r) => ['EL', 'PL', 'SL', 'CL'].includes(r.status)).length;

    res.json({
      success: true,
      data: {
        kpis: {
          activeStaff: profiles,
          lastMonthNet: records.reduce((s, r) => s + (r.netSalary || 0), 0),
          lastMonthGross: records.reduce((s, r) => s + (r.grossSalary || 0), 0),
          lastMonthStaffPaid: records.length,
          previewMonth: prevMonth
        },
        sixMonthExpense: six,
        attendanceChart: { monthYear: prevMonth, present, absent, leave },
        cutoff,
        preview: records.slice(0, 10)
      }
    });
  } catch (err) {
    next(err);
  }
};
