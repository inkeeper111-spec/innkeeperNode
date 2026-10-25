import dayjs from 'dayjs';
import mongoose from 'mongoose';
import { Expense } from '../models/index.js';
import { generateReference } from '../utils/reference.js';
import { logAudit } from '../services/auditService.js';

export const getExpenses = async (req, res, next) => {
  try {
    const { category, status, startDate, endDate, page = 1, limit = 20 } = req.query;
    const filter = { hotelId: req.hotelId };

    if (category && category !== 'all') filter.category = category;
    if (status && status !== 'all') filter.status = status;
    if (startDate && endDate) {
      filter.date = {
        $gte: dayjs(startDate).startOf('day').toDate(),
        $lte: dayjs(endDate).endOf('day').toDate()
      };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Expense.countDocuments(filter);
    const expenses = await Expense.find(filter)
      .populate('vendorId', 'name')
      .populate('createdBy', 'name')
      .populate('approvedBy', 'name')
      .sort({ date: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Summary aggregation by category
    const hotelObjectId = new mongoose.Types.ObjectId(String(req.hotelId));
    const categorySummary = await Expense.aggregate([
      { $match: { hotelId: hotelObjectId, status: 'approved' } },
      { $group: { _id: '$category', total: { $sum: '$amount' } } }
    ]);

    const monthStart = dayjs().startOf('month').toDate();
    const monthEnd = dayjs().endOf('month').toDate();
    const monthlySummary = await Expense.aggregate([
      { $match: { hotelId: hotelObjectId, status: 'approved', date: { $gte: monthStart, $lte: monthEnd } } },
      { $group: { _id: '$category', total: { $sum: '$amount' } } }
    ]);
    const monthlyTotal = monthlySummary.reduce((sum, row) => sum + row.total, 0);

    res.json({
      success: true,
      data: {
        expenses,
        categorySummary,
        monthlySummary,
        monthlyTotal,
        month: dayjs().format('YYYY-MM'),
        pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) }
      }
    });
  } catch (err) {
    next(err);
  }
};

export const createExpense = async (req, res, next) => {
  try {
    const { category, amount, date, description, vendorId, paymentMethod, receiptUrl } = req.body;

    const expense = await Expense.create({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      expenseNumber: generateReference('EXP'),
      category,
      amount: Number(amount),
      date: date || new Date(),
      description,
      vendorId: vendorId || null,
      paymentMethod: paymentMethod || 'bank_transfer',
      receiptUrl: receiptUrl || '',
      status: 'approved',
      createdBy: req.user._id,
      approvedBy: req.user._id
    });

    res.status(201).json({
      success: true,
      message: 'Expense recorded.',
      data: expense
    });
  } catch (err) {
    next(err);
  }
};

export const updateExpenseStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    const expense = await Expense.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      { status, approvedBy: req.user._id },
      { new: true }
    );

    if (!expense) {
      return res.status(404).json({ success: false, message: 'Expense not found.' });
    }

    res.json({ success: true, message: `Expense marked as ${status}.`, data: expense });
  } catch (err) {
    next(err);
  }
};

