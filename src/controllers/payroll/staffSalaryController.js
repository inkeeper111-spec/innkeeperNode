import path from 'path';
import fs from 'fs';
import ExcelJS from 'exceljs';
import { StaffSalary } from '../../models/StaffSalary.js';
import { StaffProfile } from '../../models/StaffProfile.js';
import { StaffTaxConfig } from '../../models/StaffTaxConfig.js';
import { StaffBulkUploadsLog } from '../../models/StaffBulkUploadsLog.js';
import { validateBasicPercent } from '../../services/payroll/payrollFormulas.js';

export const getStaffSalaryData = async (req, res, next) => {
  try {
    const { staffId, activeOnly } = req.body || req.query || {};
    const filter = { hotelId: req.hotelId };
    if (staffId) filter.staffId = staffId;
    if (activeOnly !== false && activeOnly !== 'false') filter.isActive = true;

    const data = await StaffSalary.find(filter)
      .populate('staffId')
      .populate('userId', 'name email phone')
      .populate('weekOff')
      .sort({ updatedAt: -1 });

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const addStaffSalary = async (req, res, next) => {
  try {
    const {
      staffId, wages, salary, basic, allowances, earnings, deductions,
      bank, pfEligible, pfNo, esiEligible, esiNo, UANNo, weekOff, isActive
    } = req.body;

    if (!staffId || salary === undefined) {
      return res.status(400).json({ success: false, message: 'staffId and salary are required.' });
    }

    const profile = await StaffProfile.findOne({ _id: staffId, hotelId: req.hotelId });
    if (!profile) {
      return res.status(404).json({ success: false, message: 'Staff profile not found.' });
    }

    const taxConfig = await StaffTaxConfig.findOne({ hotelId: req.hotelId });
    const basicCheck = validateBasicPercent(taxConfig, salary, basic ?? 0);
    if (!basicCheck.ok) {
      return res.status(400).json({ success: false, message: basicCheck.message });
    }

    const doc = await StaffSalary.create({
      hotelId: req.hotelId,
      staffId,
      userId: profile.userId,
      wages: wages || 'M',
      salary: Number(salary),
      basic: Number(basic) || 0,
      allowances: Number(allowances) || 0,
      earnings: earnings || [],
      deductions: deductions || [],
      bank: bank || {},
      pfEligible: pfEligible || 'N',
      pfNo: pfNo || '',
      esiEligible: esiEligible || 'N',
      esiNo: esiNo || '',
      UANNo: UANNo || '',
      weekOff: weekOff || null,
      isActive: isActive !== false
    });

    // Mirror base fields onto StaffProfile for legacy salary tab
    await StaffProfile.findByIdAndUpdate(staffId, {
      salary: Number(salary),
      basicSalary: Number(basic) || 0,
      allowances: Number(allowances) || 0
    });

    res.status(201).json({ success: true, message: 'Staff salary created.', data: doc });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'Salary already exists for this staff. Use update.' });
    }
    next(err);
  }
};

export const updateStaffSalary = async (req, res, next) => {
  try {
    const existing = await StaffSalary.findOne({
      $or: [
        { _id: req.params.id, hotelId: req.hotelId },
        { staffId: req.body.staffId, hotelId: req.hotelId }
      ]
    });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Staff salary not found.' });
    }

    const salary = req.body.salary !== undefined ? Number(req.body.salary) : existing.salary;
    const basic = req.body.basic !== undefined ? Number(req.body.basic) : existing.basic;
    const taxConfig = await StaffTaxConfig.findOne({ hotelId: req.hotelId });
    const basicCheck = validateBasicPercent(taxConfig, salary, basic);
    if (!basicCheck.ok) {
      return res.status(400).json({ success: false, message: basicCheck.message });
    }

    const fields = [
      'wages', 'salary', 'basic', 'allowances', 'earnings', 'deductions',
      'bank', 'pfEligible', 'pfNo', 'esiEligible', 'esiNo', 'UANNo', 'weekOff', 'isActive'
    ];
    for (const f of fields) {
      if (req.body[f] !== undefined) existing[f] = req.body[f];
    }
    await existing.save();

    await StaffProfile.findByIdAndUpdate(existing.staffId, {
      salary: existing.salary,
      basicSalary: existing.basic,
      allowances: existing.allowances
    });

    res.json({ success: true, message: 'Staff salary updated.', data: existing });
  } catch (err) {
    next(err);
  }
};

export const exportStaffTemplate = async (req, res, next) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('StaffSalary');
    ws.columns = [
      { header: 'employeeId', key: 'employeeId', width: 15 },
      { header: 'wages', key: 'wages', width: 8 },
      { header: 'salary', key: 'salary', width: 12 },
      { header: 'basic', key: 'basic', width: 12 },
      { header: 'allowances', key: 'allowances', width: 12 },
      { header: 'pfEligible', key: 'pfEligible', width: 12 },
      { header: 'esiEligible', key: 'esiEligible', width: 12 },
      { header: 'pfNo', key: 'pfNo', width: 15 },
      { header: 'esiNo', key: 'esiNo', width: 15 },
      { header: 'UANNo', key: 'UANNo', width: 18 },
      { header: 'accountName', key: 'accountName', width: 20 },
      { header: 'accountNo', key: 'accountNo', width: 18 },
      { header: 'IFSC', key: 'IFSC', width: 14 }
    ];
    ws.addRow({
      employeeId: 'EMP001',
      wages: 'M',
      salary: 25000,
      basic: 15000,
      allowances: 5000,
      pfEligible: 'Y',
      esiEligible: 'N'
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=staff-salary-template.xlsx');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
};

export const uploadStaffSalaryExcel = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Excel file is required.' });
    }
    const taxConfig = await StaffTaxConfig.findOne({ hotelId: req.hotelId });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    let successCount = 0;
    let failCount = 0;
    const errors = [];

    const headerRow = ws.getRow(1);
    const headers = {};
    headerRow.eachCell((cell, col) => {
      headers[String(cell.value || '').trim()] = col;
    });

    for (let rowNumber = 2; rowNumber <= ws.rowCount; rowNumber += 1) {
      const row = ws.getRow(rowNumber);
      const employeeId = String(row.getCell(headers.employeeId || 1).value || '').trim();
      if (!employeeId) continue;
      try {
        const profile = await StaffProfile.findOne({ hotelId: req.hotelId, employeeId });
        if (!profile) throw new Error(`Unknown employeeId ${employeeId}`);
        const salary = Number(row.getCell(headers.salary || 3).value) || 0;
        const basic = Number(row.getCell(headers.basic || 4).value) || 0;
        const check = validateBasicPercent(taxConfig, salary, basic);
        if (!check.ok) throw new Error(check.message);

        const payload = {
          hotelId: req.hotelId,
          staffId: profile._id,
          userId: profile.userId,
          wages: String(row.getCell(headers.wages || 2).value || 'M').toUpperCase().startsWith('D') ? 'D' : 'M',
          salary,
          basic,
          allowances: Number(row.getCell(headers.allowances || 5).value) || 0,
          pfEligible: String(row.getCell(headers.pfEligible || 6).value || 'N').toUpperCase().startsWith('Y') ? 'Y' : 'N',
          esiEligible: String(row.getCell(headers.esiEligible || 7).value || 'N').toUpperCase().startsWith('Y') ? 'Y' : 'N',
          pfNo: String(row.getCell(headers.pfNo || 8).value || ''),
          esiNo: String(row.getCell(headers.esiNo || 9).value || ''),
          UANNo: String(row.getCell(headers.UANNo || 10).value || ''),
          bank: {
            accountName: String(row.getCell(headers.accountName || 11).value || ''),
            accountNo: String(row.getCell(headers.accountNo || 12).value || ''),
            IFSC: String(row.getCell(headers.IFSC || 13).value || '')
          },
          isActive: true
        };

        await StaffSalary.findOneAndUpdate(
          { hotelId: req.hotelId, staffId: profile._id },
          payload,
          { upsert: true, new: true }
        );
        await StaffProfile.findByIdAndUpdate(profile._id, {
          salary, basicSalary: basic, allowances: payload.allowances
        });
        successCount += 1;
      } catch (e) {
        failCount += 1;
        errors.push(`Row ${rowNumber}: ${e.message}`);
      }
    }

    const uploadStatus = failCount === 0 ? 'S' : successCount === 0 ? 'F' : 'PS';
    const uploadDir = path.join(process.cwd(), 'uploads', 'payroll');
    fs.mkdirSync(uploadDir, { recursive: true });
    const filePath = path.join(uploadDir, `staff_${Date.now()}_${req.file.originalname}`);
    fs.writeFileSync(filePath, req.file.buffer);

    const log = await StaffBulkUploadsLog.create({
      hotelId: req.hotelId,
      uploadedBy: req.user._id,
      fileName: req.file.originalname,
      filePath,
      totalRows: successCount + failCount,
      successCount,
      failCount,
      uploadStatus,
      errors: errors.slice(0, 50)
    });

    res.json({
      success: true,
      message: `Upload ${uploadStatus === 'S' ? 'succeeded' : uploadStatus === 'PS' ? 'partially succeeded' : 'failed'}.`,
      data: log
    });
  } catch (err) {
    next(err);
  }
};

export const viewBulkUploadLogs = async (req, res, next) => {
  try {
    const data = await StaffBulkUploadsLog.find({ hotelId: req.hotelId })
      .sort({ createdAt: -1 })
      .limit(100);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getPayrollStaffData = async (req, res, next) => {
  try {
    const profiles = await StaffProfile.find({
      hotelId: req.hotelId,
      status: { $ne: 'terminated' }
    }).populate('userId', 'name email phone role');
    const salaries = await StaffSalary.find({ hotelId: req.hotelId, isActive: true });
    const byStaff = new Map(salaries.map((s) => [String(s.staffId), s]));
    const data = profiles.map((p) => ({
      ...p.toObject(),
      staffSalary: byStaff.get(String(p._id)) || null
    }));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
