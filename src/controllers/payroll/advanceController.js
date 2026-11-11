import dayjs from 'dayjs';
import { AdvancePayment } from '../../models/AdvancePayment.js';
import { AdvancePaymentBreakup } from '../../models/AdvancePaymentBreakup.js';
import { StaffProfile } from '../../models/StaffProfile.js';
import { buildAdvanceBreakups } from '../../services/payroll/payrollFormulas.js';

export const listAdvances = async (req, res, next) => {
  try {
    const { staffId } = req.query;
    const filter = { hotelId: req.hotelId, isActive: true };
    if (staffId) filter.staffId = staffId;
    const advances = await AdvancePayment.find(filter)
      .populate('staffId')
      .populate('userId', 'name email')
      .sort({ createdAt: -1 });

    const ids = advances.map((a) => a._id);
    const breakups = await AdvancePaymentBreakup.find({ advancePaymentId: { $in: ids } });
    const byAdv = new Map();
    for (const b of breakups) {
      const k = String(b.advancePaymentId);
      if (!byAdv.has(k)) byAdv.set(k, []);
      byAdv.get(k).push(b);
    }

    res.json({
      success: true,
      data: advances.map((a) => ({
        ...a.toObject(),
        breakups: byAdv.get(String(a._id)) || []
      }))
    });
  } catch (err) {
    next(err);
  }
};

export const createAdvance = async (req, res, next) => {
  try {
    const {
      staffId, advanceAmount, paymentMode, disbursedDate,
      effectiveMonth, payAmount, notes
    } = req.body;

    if (!staffId || !advanceAmount || !effectiveMonth || !payAmount) {
      return res.status(400).json({
        success: false,
        message: 'staffId, advanceAmount, effectiveMonth, and payAmount are required.'
      });
    }

    const profile = await StaffProfile.findOne({ _id: staffId, hotelId: req.hotelId });
    if (!profile) {
      return res.status(404).json({ success: false, message: 'Staff not found.' });
    }

    const advance = await AdvancePayment.create({
      hotelId: req.hotelId,
      staffId,
      userId: profile.userId,
      advanceAmount: Number(advanceAmount),
      paymentMode: paymentMode || 'cash',
      disbursedDate: dayjs(disbursedDate || undefined).toDate(),
      effectiveMonth,
      payAmount: Number(payAmount),
      notes: notes || ''
    });

    const breakups = buildAdvanceBreakups({
      advanceAmount: Number(advanceAmount),
      payAmount: Number(payAmount),
      effectiveMonth,
      hotelId: req.hotelId,
      staffId,
      advancePaymentId: advance._id
    });
    await AdvancePaymentBreakup.insertMany(breakups);

    res.status(201).json({
      success: true,
      message: 'Advance payment created.',
      data: { ...advance.toObject(), breakups }
    });
  } catch (err) {
    next(err);
  }
};

export const updateAdvance = async (req, res, next) => {
  try {
    const advance = await AdvancePayment.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!advance) {
      return res.status(404).json({ success: false, message: 'Advance not found.' });
    }

    const paid = await AdvancePaymentBreakup.findOne({
      advancePaymentId: advance._id,
      isPaid: { $in: ['Y', 'P'] }
    });
    if (paid && (req.body.advanceAmount || req.body.payAmount || req.body.effectiveMonth)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot change schedule after recovery has started. Edit notes/mode only.'
      });
    }

    if (req.body.notes !== undefined) advance.notes = req.body.notes;
    if (req.body.paymentMode) advance.paymentMode = req.body.paymentMode;
    if (req.body.disbursedDate) advance.disbursedDate = dayjs(req.body.disbursedDate).toDate();
    if (req.body.isActive !== undefined) advance.isActive = req.body.isActive;

    if (!paid && (req.body.advanceAmount || req.body.payAmount || req.body.effectiveMonth)) {
      advance.advanceAmount = Number(req.body.advanceAmount ?? advance.advanceAmount);
      advance.payAmount = Number(req.body.payAmount ?? advance.payAmount);
      advance.effectiveMonth = req.body.effectiveMonth || advance.effectiveMonth;
      await AdvancePaymentBreakup.deleteMany({ advancePaymentId: advance._id });
      const breakups = buildAdvanceBreakups({
        advanceAmount: advance.advanceAmount,
        payAmount: advance.payAmount,
        effectiveMonth: advance.effectiveMonth,
        hotelId: req.hotelId,
        staffId: advance.staffId,
        advancePaymentId: advance._id
      });
      await AdvancePaymentBreakup.insertMany(breakups);
    }

    await advance.save();
    const breakups = await AdvancePaymentBreakup.find({ advancePaymentId: advance._id });
    res.json({
      success: true,
      message: 'Advance updated.',
      data: { ...advance.toObject(), breakups }
    });
  } catch (err) {
    next(err);
  }
};

export const deleteAdvance = async (req, res, next) => {
  try {
    const advance = await AdvancePayment.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!advance) {
      return res.status(404).json({ success: false, message: 'Advance not found.' });
    }
    const paid = await AdvancePaymentBreakup.findOne({
      advancePaymentId: advance._id,
      isPaid: { $in: ['Y', 'P'] }
    });
    if (paid) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete advance after recovery has started. Mark inactive instead.'
      });
    }
    await AdvancePaymentBreakup.deleteMany({ advancePaymentId: advance._id });
    await advance.deleteOne();
    res.json({ success: true, message: 'Advance deleted.' });
  } catch (err) {
    next(err);
  }
};
