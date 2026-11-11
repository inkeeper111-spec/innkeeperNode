import path from 'path';
import fs from 'fs';
import ExcelJS from 'exceljs';
import dayjs from 'dayjs';
import { StaffHoliday } from '../../models/StaffHoliday.js';
import { HolidayBulkUploadLog } from '../../models/HolidayBulkUploadLog.js';

export const listHolidays = async (req, res, next) => {
  try {
    const { year } = req.query;
    const filter = { hotelId: req.hotelId };
    if (year) {
      filter.date = {
        $gte: dayjs(`${year}-01-01`).toDate(),
        $lte: dayjs(`${year}-12-31`).endOf('day').toDate()
      };
    }
    const data = await StaffHoliday.find(filter).sort({ date: 1 });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const createHoliday = async (req, res, next) => {
  try {
    const { holidayName, date, type } = req.body;
    if (!holidayName || !date) {
      return res.status(400).json({ success: false, message: 'holidayName and date are required.' });
    }
    const doc = await StaffHoliday.create({
      hotelId: req.hotelId,
      holidayName,
      date: dayjs(date).toDate(),
      type: type || 'National'
    });
    res.status(201).json({ success: true, message: 'Holiday created.', data: doc });
  } catch (err) {
    next(err);
  }
};

export const updateHoliday = async (req, res, next) => {
  try {
    const updates = { ...req.body };
    if (updates.date) updates.date = dayjs(updates.date).toDate();
    const doc = await StaffHoliday.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      updates,
      { new: true }
    );
    if (!doc) return res.status(404).json({ success: false, message: 'Holiday not found.' });
    res.json({ success: true, message: 'Holiday updated.', data: doc });
  } catch (err) {
    next(err);
  }
};

export const deleteHoliday = async (req, res, next) => {
  try {
    const doc = await StaffHoliday.findOneAndDelete({ _id: req.params.id, hotelId: req.hotelId });
    if (!doc) return res.status(404).json({ success: false, message: 'Holiday not found.' });
    res.json({ success: true, message: 'Holiday deleted.' });
  } catch (err) {
    next(err);
  }
};

export const exportHolidayTemplate = async (req, res, next) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Holidays');
    ws.columns = [
      { header: 'holidayName', key: 'holidayName', width: 30 },
      { header: 'date', key: 'date', width: 15 },
      { header: 'type', key: 'type', width: 15 }
    ];
    ws.addRow({ holidayName: 'Republic Day', date: '2026-01-26', type: 'National' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=holiday-template.xlsx');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
};

export const uploadHolidayExcel = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Excel file is required.' });
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    let successCount = 0;
    let failCount = 0;
    const errors = [];
    const rows = [];

    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const holidayName = String(row.getCell(1).value || '').trim();
      let dateVal = row.getCell(2).value;
      const type = String(row.getCell(3).value || 'National').trim();
      if (!holidayName || !dateVal) {
        failCount += 1;
        errors.push(`Row ${rowNumber}: missing name/date`);
        return;
      }
      if (dateVal instanceof Date) dateVal = dayjs(dateVal).format('YYYY-MM-DD');
      else dateVal = String(dateVal).trim();
      rows.push({ hotelId: req.hotelId, holidayName, date: dayjs(dateVal).toDate(), type });
    });

    for (const r of rows) {
      try {
        await StaffHoliday.create(r);
        successCount += 1;
      } catch (e) {
        failCount += 1;
        errors.push(e.message);
      }
    }

    const uploadStatus = failCount === 0 ? 'S' : successCount === 0 ? 'F' : 'PS';
    const uploadDir = path.join(process.cwd(), 'uploads', 'payroll');
    fs.mkdirSync(uploadDir, { recursive: true });
    const filePath = path.join(uploadDir, `holiday_${Date.now()}_${req.file.originalname}`);
    fs.writeFileSync(filePath, req.file.buffer);

    const log = await HolidayBulkUploadLog.create({
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

export const viewHolidayBulkUploadLogs = async (req, res, next) => {
  try {
    const data = await HolidayBulkUploadLog.find({ hotelId: req.hotelId })
      .sort({ createdAt: -1 })
      .limit(100);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
