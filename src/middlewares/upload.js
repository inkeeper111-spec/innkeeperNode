import multer from 'multer';

const storage = multer.memoryStorage();

export const uploadExcel = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      file.mimetype?.includes('sheet') ||
      file.mimetype === 'application/vnd.ms-excel' ||
      /\.xlsx?$/i.test(file.originalname || '');
    if (!ok) return cb(new Error('Only Excel files (.xlsx/.xls) are allowed.'));
    cb(null, true);
  }
});
