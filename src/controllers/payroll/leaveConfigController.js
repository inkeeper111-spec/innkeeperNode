import { StaffLeaveConfig } from '../../models/StaffLeaveConfig.js';
import { StaffLeave } from '../../models/StaffLeave.js';

export const getLeaveConfig = async (req, res, next) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const data = await StaffLeaveConfig.findOne({ hotelId: req.hotelId, year });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const upsertLeaveConfig = async (req, res, next) => {
  try {
    const year = Number(req.body.year) || new Date().getFullYear();
    const data = await StaffLeaveConfig.findOneAndUpdate(
      { hotelId: req.hotelId, year },
      {
        hotelId: req.hotelId,
        year,
        PL: Number(req.body.PL) || 0,
        SL: Number(req.body.SL) || 0,
        EL: Number(req.body.EL) || 0,
        CL: Number(req.body.CL) || 0
      },
      { upsert: true, new: true }
    );
    res.json({ success: true, message: 'Leave configuration saved.', data });
  } catch (err) {
    next(err);
  }
};

export const getStaffLeaveUsage = async (req, res, next) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const { staffId } = req.query;
    const filter = { hotelId: req.hotelId, year };
    if (staffId) filter.staffId = staffId;
    const data = await StaffLeave.find(filter);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
