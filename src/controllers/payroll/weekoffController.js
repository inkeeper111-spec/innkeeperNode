import { WeekoffCategory } from '../../models/WeekoffCategory.js';

export const listWeekoffCategories = async (req, res, next) => {
  try {
    const data = await WeekoffCategory.find({ hotelId: req.hotelId }).sort({ categoryName: 1 });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const createWeekoffCategory = async (req, res, next) => {
  try {
    const { categoryName, description, weekOff } = req.body;
    if (!categoryName) {
      return res.status(400).json({ success: false, message: 'categoryName is required.' });
    }
    const doc = await WeekoffCategory.create({
      hotelId: req.hotelId,
      categoryName,
      description: description || '',
      weekOff: weekOff || {}
    });
    res.status(201).json({ success: true, message: 'Week-off category created.', data: doc });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'Category name already exists.' });
    }
    next(err);
  }
};

export const updateWeekoffCategory = async (req, res, next) => {
  try {
    const doc = await WeekoffCategory.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      {
        categoryName: req.body.categoryName,
        description: req.body.description,
        weekOff: req.body.weekOff,
        isActive: req.body.isActive
      },
      { new: true }
    );
    if (!doc) return res.status(404).json({ success: false, message: 'Category not found.' });
    res.json({ success: true, message: 'Week-off category updated.', data: doc });
  } catch (err) {
    next(err);
  }
};

export const deleteWeekoffCategory = async (req, res, next) => {
  try {
    const doc = await WeekoffCategory.findOneAndDelete({ _id: req.params.id, hotelId: req.hotelId });
    if (!doc) return res.status(404).json({ success: false, message: 'Category not found.' });
    res.json({ success: true, message: 'Week-off category deleted.' });
  } catch (err) {
    next(err);
  }
};
