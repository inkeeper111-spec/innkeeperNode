import { StaffTaxConfig } from '../../models/StaffTaxConfig.js';

export const getStaffTaxConfig = async (req, res, next) => {
  try {
    const config = await StaffTaxConfig.findOne({ hotelId: req.hotelId });
    res.json({ success: true, data: config });
  } catch (err) {
    next(err);
  }
};

export const upsertStaffTaxConfig = async (req, res, next) => {
  try {
    const payload = {
      hotelId: req.hotelId,
      basicPercent: Number(req.body.basicPercent) || 0,
      earnings: req.body.earnings || [],
      deductions: req.body.deductions || [],
      pfPercent: Number(req.body.pfPercent) ?? 12,
      pfActive: req.body.pfActive !== false,
      esiPercent: Number(req.body.esiPercent) ?? 0.75,
      esiActive: req.body.esiActive !== false,
      professionTax: req.body.professionTax || { mode: 'FIXED', fixedAmount: 0, slabs: [] }
    };

    if (payload.professionTax.mode === 'SLAB' && (!payload.professionTax.slabs || !payload.professionTax.slabs.length)) {
      return res.status(400).json({
        success: false,
        message: 'Profession tax SLAB mode requires at least one slab.'
      });
    }

    const config = await StaffTaxConfig.findOneAndUpdate(
      { hotelId: req.hotelId },
      payload,
      { upsert: true, new: true }
    );

    res.json({ success: true, message: 'Statutory / tax configuration saved.', data: config });
  } catch (err) {
    next(err);
  }
};
