import { getAIAnalytics } from '../services/aiService.js';

export const askAIAssistant = async (req, res, next) => {
  try {
    const { query } = req.body;
    if (!query || !query.trim()) {
      return res.status(400).json({ success: false, message: 'Please provide a question or query for the AI assistant.' });
    }

    const result = await getAIAnalytics(req.hotelId, query.trim());

    res.json({
      success: true,
      data: result
    });
  } catch (err) {
    next(err);
  }
};

export const getAIInsights = async (req, res, next) => {
  try {
    const result = await getAIAnalytics(req.hotelId, 'summary');
    res.json({
      success: true,
      data: {
        insights: result.insights,
        metrics: result.metrics
      }
    });
  } catch (err) {
    next(err);
  }
};

