import { GlobalConfiguration } from '../../models/GlobalConfiguration.js';
import { getCutoffStatus } from '../../services/payroll/cutoff.js';

export const getGlobalConfiguration = async (req, res, next) => {
  try {
    const config = await GlobalConfiguration.findOne({ hotelId: req.hotelId });
    res.json({ success: true, data: config });
  } catch (err) {
    next(err);
  }
};

export const upsertGlobalConfiguration = async (req, res, next) => {
  try {
    const { attendanceCutoffDay, payrollCutoffDay } = req.body;
    if (!attendanceCutoffDay || !payrollCutoffDay) {
      return res.status(400).json({
        success: false,
        message: 'attendanceCutoffDay and payrollCutoffDay are required (1–31).'
      });
    }
    const a = Number(attendanceCutoffDay);
    const p = Number(payrollCutoffDay);
    if (a < 1 || a > 31 || p < 1 || p > 31) {
      return res.status(400).json({
        success: false,
        message: 'Cut-off days must be between 1 and 31.'
      });
    }

    const config = await GlobalConfiguration.findOneAndUpdate(
      { hotelId: req.hotelId },
      { hotelId: req.hotelId, attendanceCutoffDay: a, payrollCutoffDay: p },
      { upsert: true, new: true }
    );

    res.json({ success: true, message: 'Global configuration saved.', data: config });
  } catch (err) {
    next(err);
  }
};

export const getCutoffWindow = async (req, res, next) => {
  try {
    const { monthYear, type = 'attendance' } = req.query;
    if (!monthYear) {
      return res.status(400).json({ success: false, message: 'monthYear (YYYY-MM) is required.' });
    }
    const result = await getCutoffStatus(req.hotelId, monthYear, type);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};
