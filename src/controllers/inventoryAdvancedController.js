import mongoose from 'mongoose';
import {
  DepartmentRequest, GoodsReceipt, InventoryBalance, InventoryBatch, InventoryItem, InventoryRecipe, StockAdjustment,
  MinibarStock, MinibarTransaction, PurchaseOrder, RecipeConsumption, StockMovement, Room, Reservation, Invoice
} from '../models/index.js';
import { generateReference } from '../utils/reference.js';
import { logAudit } from '../services/auditService.js';
import { postStockMovement, runInventoryTransaction, transferStock } from '../services/inventoryService.js';

const adminOnly = (req, res) => {
  if (['hotel_admin', 'super_admin'].includes(req.user?.role)) return true;
  res.status(403).json({ success: false, message: 'Hotel administrator approval is required.' });
  return false;
};

const tenantFilter = (req) => ({
  hotelId: req.hotelId,
  ...(req.propertyId ? { propertyId: req.propertyId } : {})
});

const dateFilter = (query) => {
  const filter = {};
  if (query.from) {
    const from = new Date(query.from);
    if (Number.isNaN(from.getTime())) throw Object.assign(new Error('Invalid start date.'), { statusCode: 400 });
    filter.$gte = from;
  }
  if (query.to) {
    const to = new Date(query.to);
    if (Number.isNaN(to.getTime())) throw Object.assign(new Error('Invalid end date.'), { statusCode: 400 });
    to.setHours(23, 59, 59, 999);
    filter.$lte = to;
  }
  return Object.keys(filter).length ? filter : undefined;
};

export const getInventoryDashboard = async (req, res, next) => {
  try {
    const scope = tenantFilter(req);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const expiryEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const [items, expiredBatches, pendingOrders, monthPurchases, recent, expiring, monthlyPurchases, departmentUse] = await Promise.all([
      InventoryItem.find({ ...scope, isActive: true }).select('currentStock minStockThreshold unitCost').lean(),
      InventoryBatch.aggregate([
        { $match: { ...scope, expiryDate: { $lte: now }, remainingQuantity: { $gt: 0 } } },
        { $group: { _id: '$itemId', quantity: { $sum: '$remainingQuantity' } } }
      ]),
      PurchaseOrder.countDocuments({ ...scope, status: { $in: ['pending_approval', 'approved', 'ordered', 'partially_received'] } }),
      PurchaseOrder.aggregate([
        { $match: { ...scope, createdAt: { $gte: monthStart, $lt: nextMonth }, status: { $ne: 'cancelled' } } },
        { $group: { _id: null, total: { $sum: '$totalAmount' }, count: { $sum: 1 } } }
      ]),
      StockMovement.find(scope).populate('itemId', 'name unit').populate('recordedBy', 'name')
        .sort({ createdAt: -1 }).limit(8).lean(),
      GoodsReceipt.aggregate([
        { $match: { ...scope, 'lines.expiryDate': { $gte: now, $lte: expiryEnd } } },
        { $unwind: '$lines' },
        { $match: { 'lines.expiryDate': { $gte: now, $lte: expiryEnd }, 'lines.acceptedQuantity': { $gt: 0 } } },
        { $lookup: { from: 'inventoryitems', localField: 'lines.itemId', foreignField: '_id', as: 'item' } },
        { $unwind: '$item' },
        { $project: { _id: 0, item: '$item.name', batchNumber: '$lines.batchNumber', expiryDate: '$lines.expiryDate', quantity: '$lines.acceptedQuantity' } },
        { $sort: { expiryDate: 1 } },
        { $limit: 10 }
      ]),
      StockMovement.aggregate([
        { $match: { ...scope, createdAt: { $gte: new Date(now.getFullYear(), now.getMonth() - 5, 1) }, movementType: { $in: ['receipt'] } } },
        { $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }, total: { $sum: '$totalValue' } } },
        { $sort: { '_id.year': 1, '_id.month': 1 } }
      ]),
      StockMovement.aggregate([
        { $match: { ...scope, movementType: { $in: ['issue', 'department_issue', 'recipe_consumption', 'wastage', 'expiry'] } } },
        { $group: { _id: { $ifNull: ['$department', 'Unassigned'] }, quantity: { $sum: '$quantity' }, expense: { $sum: '$totalValue' } } },
        { $sort: { expense: -1 } }
      ])
    ]);

    const expiredByItem = new Map(expiredBatches.map((batch) => [String(batch._id), batch.quantity]));
    const availableByItem = items.map((item) => ({
      ...item,
      available: Math.max(0, item.currentStock - (expiredByItem.get(String(item._id)) || 0))
    }));
    res.json({
      success: true,
      data: {
        totalItems: items.length,
        totalStockValue: items.reduce((sum, item) => sum + item.currentStock * item.unitCost, 0),
        availableStock: availableByItem.reduce((sum, item) => sum + item.available, 0),
        lowStockItems: availableByItem.filter((item) => item.available > 0 && item.available <= item.minStockThreshold).length,
        outOfStockItems: availableByItem.filter((item) => item.available <= 0).length,
        pendingPurchaseOrders: pendingOrders,
        purchasesThisMonth: monthPurchases[0]?.total || 0,
        purchaseCountThisMonth: monthPurchases[0]?.count || 0,
        monthlyPurchases,
        departmentConsumption: departmentUse,
        recentActivities: recent,
        expiringProducts: expiring
      }
    });
  } catch (err) {
    next(err);
  }
};

export const getStockLocations = async (req, res, next) => {
  try {
    const balances = await InventoryBalance.find(tenantFilter(req))
      .populate('itemId', 'name code unit currentStock unitCost')
      .sort({ location: 1 })
      .lean();
    res.json({ success: true, data: balances });
  } catch (err) {
    next(err);
  }
};

export const transferStockBetweenLocations = async (req, res, next) => {
  try {
    const { itemId, quantity, fromLocation, toLocation, department, notes } = req.body;
    const result = await runInventoryTransaction((session) => transferStock({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      itemId,
      quantity,
      fromLocation,
      toLocation,
      department: department || '',
      recordedBy: req.user._id,
      referenceNumber: generateReference('TRF'),
      idempotencyKey: req.body.idempotencyKey || req.get('Idempotency-Key'),
      notes: notes || '',
      session
    }));
    res.status(result.duplicate ? 200 : 201).json({
      success: true,
      message: result.duplicate ? 'Stock transfer was already recorded.' : 'Stock transferred successfully.',
      data: result
    });
  } catch (err) {
    next(err);
  }
};

export const getStockLedger = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, itemId, movementType, department, location, from, to } = req.query;
    const filter = tenantFilter(req);
    if (itemId) filter.itemId = itemId;
    if (movementType) filter.movementType = movementType;
    if (department) filter.department = department;
    if (location) filter.location = location;
    const createdAt = dateFilter({ from, to });
    if (createdAt) filter.createdAt = createdAt;
    const pageNumber = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(limit) || 50));
    const [data, total] = await Promise.all([
      StockMovement.find(filter)
        .populate('itemId', 'name code unit')
        .populate('recordedBy', 'name')
        .sort({ createdAt: -1 })
        .skip((pageNumber - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      StockMovement.countDocuments(filter)
    ]);
    res.json({ success: true, data, pagination: { page: pageNumber, limit: pageSize, total, pages: Math.ceil(total / pageSize) } });
  } catch (err) {
    next(err);
  }
};

export const getGoodsReceipts = async (req, res, next) => {
  try {
    const data = await GoodsReceipt.find(tenantFilter(req))
      .populate('purchaseOrderId', 'poNumber vendorId')
      .populate('receivedBy', 'name')
      .populate('lines.itemId', 'name code unit')
      .sort({ receivedAt: -1 })
      .limit(Math.min(200, Number(req.query.limit) || 50))
      .lean();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getStockAdjustments = async (req, res, next) => {
  try {
    const filter = tenantFilter(req);
    if (req.query.status) filter.status = req.query.status;
    const data = await StockAdjustment.find(filter)
      .populate('itemId', 'name code unit')
      .populate('reportedBy approvedBy', 'name')
      .sort({ createdAt: -1 })
      .limit(Math.min(200, Number(req.query.limit) || 100))
      .lean();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const createStockAdjustment = async (req, res, next) => {
  try {
    const { itemId, quantity, reason, department, location, remarks } = req.body;
    const amount = Number(quantity);
    const reasons = ['expired', 'damaged', 'food_wastage', 'spillage', 'missing', 'physical_mismatch', 'internal_usage'];
    if (!mongoose.isValidObjectId(itemId) || !Number.isFinite(amount) || amount < 0
      || (amount === 0 && reason !== 'physical_mismatch') || !reasons.includes(reason)) {
      return res.status(400).json({ success: false, message: 'Provide a valid item, non-negative physical count or positive adjustment quantity, and supported reason.' });
    }
    const itemExists = await InventoryItem.exists({ _id: itemId, ...tenantFilter(req), isActive: true });
    if (!itemExists) return res.status(404).json({ success: false, message: 'Active inventory item not found.' });
    const adjustment = await StockAdjustment.create({
      ...tenantFilter(req),
      itemId,
      quantity: amount,
      reason,
      department: department || '',
      location: location || 'Main Store',
      remarks: remarks || '',
      reportedBy: req.user._id
    });
    res.status(201).json({ success: true, data: adjustment });
  } catch (err) {
    next(err);
  }
};

export const reviewStockAdjustment = async (req, res, next) => {
  try {
    if (!adminOnly(req, res)) return;
    const { decision } = req.body;
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ success: false, message: 'Decision must be approve or reject.' });
    }
    const result = await runInventoryTransaction(async (session) => {
      const adjustment = await StockAdjustment.findOne({
        _id: req.params.id, ...tenantFilter(req), status: 'pending'
      }).session(session);
      if (!adjustment) throw Object.assign(new Error('Pending stock adjustment not found.'), { statusCode: 404 });
      adjustment.status = decision === 'approve' ? 'approved' : 'rejected';
      adjustment.approvedBy = req.user._id;
      adjustment.approvedAt = new Date();
      if (decision === 'approve') {
        const movementType = {
          expired: 'expiry',
          damaged: 'wastage',
          food_wastage: 'wastage',
          spillage: 'wastage',
          missing: 'wastage',
          physical_mismatch: 'physical_count',
          internal_usage: 'issue'
        }[adjustment.reason];
        const movement = await postStockMovement({
          hotelId: req.hotelId,
          propertyId: req.propertyId,
          itemId: adjustment.itemId,
          movementType,
          quantity: adjustment.quantity,
          location: adjustment.location,
          department: adjustment.department,
          referenceNumber: `ADJ-${adjustment._id}`,
          notes: `${adjustment.reason}: ${adjustment.remarks}`,
          recordedBy: req.user._id,
          idempotencyKey: `stock-adjustment:${adjustment._id}`,
          session
        });
        adjustment.movementId = movement.movement._id;
      }
      await adjustment.save({ session });
      return adjustment;
    });
    await logAudit({
      hotelId: req.hotelId,
      action: `STOCK_ADJUSTMENT_${decision.toUpperCase()}`,
      entity: 'StockAdjustment',
      entityId: result._id,
      details: { itemId: String(result.itemId), quantity: result.quantity, reason: result.reason },
      req
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

const resolveMinibarRoom = async (req, session) => {
  const room = await Room.findOne({
    _id: req.params.roomId,
    ...tenantFilter(req),
    isActive: true
  }).session(session);
  if (!room) throw Object.assign(new Error('Room not found in this property.'), { statusCode: 404 });
  return room;
};

export const getMinibarRooms = async (req, res, next) => {
  try {
    const rooms = await Room.find({ ...tenantFilter(req), isActive: true })
      .select('roomNumber roomStatus')
      .sort({ roomNumber: 1 })
      .lean();
    res.json({ success: true, data: rooms });
  } catch (err) {
    next(err);
  }
};

export const getMinibarRoomStock = async (req, res, next) => {
  try {
    const room = await resolveMinibarRoom(req);
    const [stock, transactions] = await Promise.all([
      MinibarStock.find({ ...tenantFilter(req), roomId: room._id })
        .populate('itemId', 'name code unit sellingPrice unitCost')
        .sort({ 'itemId.name': 1 })
        .lean(),
      MinibarTransaction.find({ ...tenantFilter(req), roomId: room._id })
        .populate('itemId', 'name code unit')
        .populate('recordedBy', 'name')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean()
    ]);
    res.json({ success: true, data: { room, stock, transactions } });
  } catch (err) {
    next(err);
  }
};

export const assignMinibarStock = async (req, res, next) => {
  try {
    const { items, idempotencyKey } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: 'At least one minibar item and quantity are required.' });
    }
    const requestKey = String(idempotencyKey || req.get('Idempotency-Key') || generateReference('MB'));
    if (requestKey.length > 120) return res.status(400).json({ success: false, message: 'Idempotency key is too long.' });
    const result = await runInventoryTransaction(async (session) => {
      const alreadyRecorded = await MinibarTransaction.findOne({
        ...tenantFilter(req),
        idempotencyKey: { $in: items.map((line) => `${requestKey}:${line.itemId}:record`) }
      }).session(session);
      if (alreadyRecorded) return { duplicate: true, transactions: [] };
      const room = await resolveMinibarRoom(req, session);
      const transactions = [];
      for (const line of items) {
        const quantity = Number(line.quantity);
        if (!mongoose.isValidObjectId(line.itemId) || !Number.isFinite(quantity) || quantity <= 0) {
          throw Object.assign(new Error('Minibar assignment quantities must be positive.'), { statusCode: 400 });
        }
        const item = await InventoryItem.findOne({
          _id: line.itemId, ...tenantFilter(req), isActive: true
        }).session(session);
        if (!item) throw Object.assign(new Error('Minibar item not found.'), { statusCode: 404 });
        const roomLocation = `Room ${room.roomNumber}`;
        const movement = await transferStock({
          hotelId: req.hotelId,
          propertyId: req.propertyId,
          itemId: item._id,
          quantity,
          fromLocation: line.fromLocation || 'Minibar Store',
          toLocation: roomLocation,
          department: 'Minibar',
          recordedBy: req.user._id,
          referenceNumber: `MINIBAR-${room.roomNumber}`,
          idempotencyKey: `${requestKey}:${item._id}:transfer`,
          session
        });
        let stock = await MinibarStock.findOne({
          ...tenantFilter(req), roomId: room._id, itemId: item._id
        }).session(session);
        if (stock) {
          stock.quantity += quantity;
          await stock.save({ session });
        } else {
          [stock] = await MinibarStock.create([{
            ...tenantFilter(req), roomId: room._id, itemId: item._id,
            openingQuantity: quantity, quantity
          }], { session });
        }
        const [transaction] = await MinibarTransaction.create([{
          ...tenantFilter(req),
          roomId: room._id,
          itemId: item._id,
          type: 'replenishment',
          quantity,
          idempotencyKey: `${requestKey}:${item._id}:record`,
          recordedBy: req.user._id
        }], { session });
        transactions.push({ transaction, stock, movement });
      }
      return { duplicate: false, transactions };
    });
    res.status(result.duplicate ? 200 : 201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

export const reconcileMinibar = async (req, res, next) => {
  try {
    const { items, idempotencyKey, notes = '' } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: 'At least one minibar reconciliation line is required.' });
    }
    const requestKey = String(idempotencyKey || req.get('Idempotency-Key') || generateReference('MB'));
    if (requestKey.length > 120) return res.status(400).json({ success: false, message: 'Idempotency key is too long.' });
    const result = await runInventoryTransaction(async (session) => {
      const alreadyRecorded = await MinibarTransaction.findOne({
        ...tenantFilter(req),
        idempotencyKey: {
          $in: items.flatMap((line) => ['consumption', 'complimentary', 'damaged', 'missing']
            .map((type) => `${requestKey}:${line.itemId}:${type}:record`))
        }
      }).session(session);
      if (alreadyRecorded) return { duplicate: true, transactions: [] };
      const room = await resolveMinibarRoom(req, session);
      const reservation = await Reservation.findOne({
        hotelId: req.hotelId,
        propertyId: req.propertyId,
        status: 'checked_in',
        'rooms.roomId': room._id
      }).session(session);
      const invoice = reservation
        ? await Invoice.findOne({ hotelId: req.hotelId, propertyId: req.propertyId, reservationId: reservation._id }).session(session)
        : null;
      const recorded = [];
      for (const line of items) {
        const stock = await MinibarStock.findOne({
          ...tenantFilter(req), roomId: room._id, itemId: line.itemId
        }).session(session);
        if (!stock) throw Object.assign(new Error('Minibar stock item is not assigned to this room.'), { statusCode: 404 });
        const item = await InventoryItem.findOne({
          _id: stock.itemId, ...tenantFilter(req), isActive: true
        }).session(session);
        if (!item) throw Object.assign(new Error('Minibar item is no longer active.'), { statusCode: 409 });
        const quantities = {
          consumption: Number(line.consumedQuantity || 0),
          complimentary: Number(line.complimentaryQuantity || 0),
          damaged: Number(line.damagedQuantity || 0),
          missing: Number(line.missingQuantity || 0)
        };
        if (!Object.values(quantities).every((quantity) => Number.isFinite(quantity) && quantity >= 0)
          || Object.values(quantities).reduce((sum, quantity) => sum + quantity, 0) > stock.quantity) {
          throw Object.assign(new Error(`Reconciled quantity exceeds available minibar stock for ${item.name}.`), { statusCode: 409 });
        }
        const chargedQuantity = quantities.consumption;
        const unitPrice = item.sellingPrice ?? item.unitCost;
        const chargeAmount = Math.round(chargedQuantity * unitPrice * 100) / 100;
        if (chargeAmount > 0 && (!reservation || !invoice)) {
          throw Object.assign(new Error('A checked-in guest reservation and invoice are required to charge minibar consumption.'), { statusCode: 409 });
        }
        const totalDeducted = Object.values(quantities).reduce((sum, quantity) => sum + quantity, 0);
        if (totalDeducted > 0) {
          const updated = await MinibarStock.updateOne({
            _id: stock._id, quantity: { $gte: totalDeducted }
          }, { $inc: { quantity: -totalDeducted } }, { session });
          if (updated.modifiedCount !== 1) throw Object.assign(new Error('Minibar stock changed concurrently; reconcile again.'), { statusCode: 409 });
        }
        for (const [type, quantity] of Object.entries(quantities)) {
          if (!quantity) continue;
          const movementType = type === 'damaged' || type === 'missing' ? 'wastage' : 'issue';
          const movement = await postStockMovement({
            hotelId: req.hotelId,
            propertyId: req.propertyId,
            itemId: item._id,
            movementType,
            quantity,
            location: `Room ${room.roomNumber}`,
            department: 'Minibar',
            referenceNumber: `ROOM-${room.roomNumber}`,
            notes: `${type} minibar item. ${notes}`.trim(),
            recordedBy: req.user._id,
            idempotencyKey: `${requestKey}:${item._id}:${type}`,
            session
          });
          const [transaction] = await MinibarTransaction.create([{
            ...tenantFilter(req),
            roomId: room._id,
            itemId: item._id,
            reservationId: reservation?._id || null,
            invoiceId: chargeAmount > 0 && type === 'consumption' ? invoice._id : null,
            type,
            quantity,
            unitPrice: type === 'consumption' ? unitPrice : 0,
            chargeAmount: type === 'consumption' ? chargeAmount : 0,
            idempotencyKey: `${requestKey}:${item._id}:${type}:record`,
            recordedBy: req.user._id,
            notes
          }], { session });
          recorded.push({ transaction, movement: movement.movement });
        }
        if (chargeAmount > 0) {
          invoice.items.push({
            description: `Minibar: ${item.name} (Room ${room.roomNumber})`,
            quantity: chargedQuantity,
            unitPrice,
            amount: chargeAmount,
            itemType: 'amenity',
            sourceRef: `${room._id}:${item._id}:${requestKey}`
          });
          invoice.subtotal = Math.round((invoice.subtotal + chargeAmount) * 100) / 100;
          invoice.totalAmount = Math.round((invoice.totalAmount + chargeAmount) * 100) / 100;
          invoice.balanceAmount = Math.round((invoice.totalAmount - invoice.paidAmount) * 100) / 100;
          reservation.totalAmount = Math.round((reservation.totalAmount + chargeAmount) * 100) / 100;
          reservation.balanceAmount = Math.round((reservation.totalAmount - reservation.paidAmount) * 100) / 100;
        }
      }
      if (invoice && recorded.length) await invoice.save({ session });
      if (reservation && recorded.length) await reservation.save({ session });
      return { duplicate: false, transactions: recorded };
    });
    res.status(result.duplicate ? 200 : 201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

export const approvePurchaseOrder = async (req, res, next) => {
  try {
    if (!adminOnly(req, res)) return;
    const po = await PurchaseOrder.findOneAndUpdate({
      _id: req.params.id, ...tenantFilter(req), status: { $in: ['draft', 'pending_approval'] }
    }, {
      $set: { status: 'ordered', approvedBy: req.user._id, approvedAt: new Date() }
    }, { new: true, runValidators: true });
    if (!po) return res.status(404).json({ success: false, message: 'Pending purchase order not found.' });
    await logAudit({
      hotelId: req.hotelId,
      action: 'APPROVE_INVENTORY_PURCHASE_ORDER',
      entity: 'PurchaseOrder',
      entityId: po._id,
      details: { poNumber: po.poNumber },
      req
    });
    res.json({ success: true, data: po });
  } catch (err) {
    next(err);
  }
};

export const getReorderSuggestions = async (req, res, next) => {
  try {
    const [items, openOrders, expiredBatches] = await Promise.all([
      InventoryItem.find({ ...tenantFilter(req), isActive: true }).select('name code unit currentStock minStockThreshold reorderQuantity unitCost vendorId').lean(),
      PurchaseOrder.find({ ...tenantFilter(req), status: { $in: ['ordered', 'partially_received', 'approved'] } })
        .select('items status').lean(),
      InventoryBatch.aggregate([
        { $match: { ...tenantFilter(req), expiryDate: { $lte: new Date() }, remainingQuantity: { $gt: 0 } } },
        { $group: { _id: '$itemId', quantity: { $sum: '$remainingQuantity' } } }
      ])
    ]);
    const pending = new Map();
    const expired = new Map(expiredBatches.map((batch) => [String(batch._id), batch.quantity]));
    for (const order of openOrders) {
      for (const line of order.items) {
        const key = String(line.itemId || '');
        pending.set(key, (pending.get(key) || 0) + Math.max(0, line.quantity - (line.receivedQuantity || 0)));
      }
    }
    const data = items.filter((item) => (
      Math.max(0, item.currentStock - (expired.get(String(item._id)) || 0))
        + (pending.get(String(item._id)) || 0) <= item.minStockThreshold
    )).map((item) => {
      const onOrder = pending.get(String(item._id)) || 0;
      const availableStock = Math.max(0, item.currentStock - (expired.get(String(item._id)) || 0));
      const target = Math.max(item.reorderQuantity || 0, item.minStockThreshold - availableStock - onOrder);
      return { ...item, availableStock, pendingPurchaseQuantity: onOrder, suggestedQuantity: Math.max(0, target) };
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getDepartmentRequests = async (req, res, next) => {
  try {
    const filter = tenantFilter(req);
    if (req.query.status) filter.status = req.query.status;
    if (req.query.department) filter.department = req.query.department;
    const data = await DepartmentRequest.find(filter)
      .populate('requestedBy approvedBy', 'name')
      .populate('lines.itemId', 'name code unit currentStock')
      .sort({ createdAt: -1 })
      .limit(Math.min(200, Number(req.query.limit) || 100))
      .lean();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const createDepartmentRequest = async (req, res, next) => {
  try {
    const { department, lines, notes } = req.body;
    if (!department?.trim() || !Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ success: false, message: 'Department and at least one requested item are required.' });
    }
    const parsedLines = [];
    for (const line of lines) {
      const quantity = Number(line.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return res.status(400).json({ success: false, message: 'Requested quantities must be positive.' });
      }
      const itemExists = await InventoryItem.exists({
        _id: line.itemId, ...tenantFilter(req), isActive: true
      });
      if (!itemExists) return res.status(400).json({ success: false, message: 'Request contains an invalid inventory item.' });
      parsedLines.push({ itemId: line.itemId, quantity, unit: line.unit || '' });
    }
    const [request] = await DepartmentRequest.create([{
      ...tenantFilter(req),
      department: department.trim(),
      lines: parsedLines,
      notes: notes || '',
      requestedBy: req.user._id
    }]);
    res.status(201).json({ success: true, data: request });
  } catch (err) {
    next(err);
  }
};

export const reviewDepartmentRequest = async (req, res, next) => {
  try {
    if (!adminOnly(req, res)) return;
    const { decision, lines } = req.body;
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ success: false, message: 'Decision must be approve or reject.' });
    }
    const result = await runInventoryTransaction(async (session) => {
      const request = await DepartmentRequest.findOne({
        _id: req.params.id, ...tenantFilter(req), status: 'pending'
      }).session(session);
      if (!request) throw Object.assign(new Error('Pending department request not found.'), { statusCode: 404 });
      if (decision === 'reject') {
        request.status = 'rejected';
        request.approvedBy = req.user._id;
        request.approvedAt = new Date();
        await request.save({ session });
        return request;
      }
      const issuedLines = lines || request.lines;
      for (const input of issuedLines) {
        const line = request.lines.find((candidate) => String(candidate.itemId) === String(input.itemId));
        if (!line) throw Object.assign(new Error('Issue contains an item that was not requested.'), { statusCode: 400 });
        const quantity = Number(input.quantity ?? line.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0 || quantity > line.quantity) {
          throw Object.assign(new Error('Issued quantity must be positive and cannot exceed the requested quantity.'), { statusCode: 400 });
        }
        await postStockMovement({
          hotelId: req.hotelId,
          propertyId: req.propertyId,
          itemId: line.itemId,
          movementType: 'department_issue',
          quantity,
          location: input.location || 'Main Store',
          department: request.department,
          referenceNumber: `REQ-${request._id}`,
          notes: request.notes || 'Approved department stock issue',
          recordedBy: req.user._id,
          idempotencyKey: `department-request:${request._id}:${line.itemId}`,
          session
        });
        line.issuedQuantity = quantity;
      }
      request.status = request.lines.every((line) => line.issuedQuantity >= line.quantity) ? 'issued' : 'partially_issued';
      request.approvedBy = req.user._id;
      request.approvedAt = new Date();
      await request.save({ session });
      return request;
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

export const getRecipes = async (req, res, next) => {
  try {
    const filter = tenantFilter(req);
    if (req.query.menuItemId) filter.menuItemId = req.query.menuItemId;
    const recipes = await InventoryRecipe.find(filter)
      .populate('menuItemId', 'name price')
      .populate('ingredients.itemId', 'name code unit unitCost')
      .populate('ingredients.substitutions.itemId', 'name code unit')
      .sort({ menuItemId: 1, version: -1 })
      .lean();
    res.json({ success: true, data: recipes });
  } catch (err) {
    next(err);
  }
};

export const saveRecipe = async (req, res, next) => {
  try {
    if (!['hotel_admin', 'super_admin'].includes(req.user?.role)) {
      return res.status(403).json({ success: false, message: 'Only hotel administrators can manage recipes.' });
    }
    const { menuItemId, ingredients } = req.body;
    if (!mongoose.isValidObjectId(menuItemId) || !Array.isArray(ingredients) || !ingredients.length) {
      return res.status(400).json({ success: false, message: 'Menu item and at least one ingredient are required.' });
    }
    const MenuItem = mongoose.model('MenuItem');
    const menuItemExists = await MenuItem.exists({ _id: menuItemId, hotelId: req.hotelId });
    if (!menuItemExists) return res.status(404).json({ success: false, message: 'Menu item not found.' });
    for (const ingredient of ingredients) {
      if (!mongoose.isValidObjectId(ingredient.itemId) || !Number.isFinite(Number(ingredient.quantity)) || Number(ingredient.quantity) <= 0) {
        return res.status(400).json({ success: false, message: 'Each recipe ingredient needs a valid item and positive quantity.' });
      }
      const exists = await InventoryItem.exists({ _id: ingredient.itemId, ...tenantFilter(req), isActive: true });
      if (!exists) return res.status(400).json({ success: false, message: 'Recipe contains an invalid inventory item.' });
      if (!Array.isArray(ingredient.substitutions || [])) {
        return res.status(400).json({ success: false, message: 'Recipe substitutions must be a list.' });
      }
      for (const substitution of ingredient.substitutions || []) {
        if (!mongoose.isValidObjectId(substitution.itemId)
          || (substitution.quantity !== undefined && (!Number.isFinite(Number(substitution.quantity)) || Number(substitution.quantity) <= 0))) {
          return res.status(400).json({ success: false, message: 'Recipe substitutions must include a valid item and positive optional quantity.' });
        }
        const substituteExists = await InventoryItem.exists({
          _id: substitution.itemId, ...tenantFilter(req), isActive: true
        });
        if (!substituteExists) return res.status(400).json({ success: false, message: 'Recipe substitution contains an invalid inventory item.' });
      }
    }
    const recipe = await runInventoryTransaction(async (session) => {
      const previous = await InventoryRecipe.findOne({
        ...tenantFilter(req), menuItemId, isActive: true
      }).sort({ version: -1 }).session(session);
      if (previous) {
        previous.isActive = false;
        await previous.save({ session });
      }
      const version = (previous?.version || 0) + 1;
      const [created] = await InventoryRecipe.create([{
        ...tenantFilter(req),
        menuItemId,
        ingredients: ingredients.map((ingredient) => ({
          itemId: ingredient.itemId,
          quantity: Number(ingredient.quantity),
          unit: ingredient.unit,
          optional: Boolean(ingredient.optional),
          substitutions: ingredient.substitutions || []
        })),
        version,
        createdBy: req.user._id
      }], { session });
      return created;
    });
    res.status(201).json({ success: true, data: recipe });
  } catch (err) {
    next(err);
  }
};

export const getInventoryReport = async (req, res, next) => {
  try {
    const { type = 'stock', category, department, itemId, from, to } = req.query;
    const scope = tenantFilter(req);
    const createdAt = dateFilter({ from, to });
    if (type === 'stock' || type === 'valuation') {
      const filter = { ...scope, ...(category && category !== 'all' ? { category } : {}) };
      const items = await InventoryItem.find(filter).populate('vendorId', 'name').sort({ name: 1 }).lean();
      const expiredBatches = await InventoryBatch.aggregate([
        { $match: { ...scope, itemId: { $in: items.map((item) => item._id) }, expiryDate: { $lte: new Date() }, remainingQuantity: { $gt: 0 } } },
        { $group: { _id: '$itemId', quantity: { $sum: '$remainingQuantity' } } }
      ]);
      const expired = new Map(expiredBatches.map((batch) => [String(batch._id), batch.quantity]));
      const data = items.map((item) => ({
        ...item,
        availableStock: Math.max(0, item.currentStock - (expired.get(String(item._id)) || 0)),
        ...(type === 'valuation' ? { stockValue: item.currentStock * item.unitCost } : {})
      }));
      return res.json({
        success: true,
        data
      });
    }
    if (type === 'purchases') {
      const filter = { ...scope, ...(createdAt ? { createdAt } : {}) };
      const data = await PurchaseOrder.find(filter).populate('vendorId', 'name').sort({ createdAt: -1 }).lean();
      return res.json({ success: true, data });
    }
    if (type === 'recipe-consumption') {
      const filter = { ...scope, ...(createdAt ? { createdAt } : {}) };
      const data = await RecipeConsumption.find(filter).populate('ingredients.itemId', 'name code unit').sort({ createdAt: -1 }).lean();
      return res.json({ success: true, data });
    }
    if (type === 'expiry') {
      const pipeline = [
        { $match: { ...scope } },
        { $unwind: '$lines' },
        { $match: { 'lines.expiryDate': { $ne: null }, ...(createdAt ? { 'lines.expiryDate': createdAt } : {}) } },
        { $lookup: { from: 'inventoryitems', localField: 'lines.itemId', foreignField: '_id', as: 'item' } },
        { $unwind: '$item' },
        ...(category && category !== 'all' ? [{ $match: { 'item.category': category } }] : []),
        { $project: {
          _id: 0,
          itemId: '$item._id',
          itemName: '$item.name',
          code: '$item.code',
          unit: '$item.unit',
          batchNumber: '$lines.batchNumber',
          expiryDate: '$lines.expiryDate',
          quantity: '$lines.acceptedQuantity',
          receiptNumber: 1,
          receivedAt: 1
        } },
        { $sort: { expiryDate: 1 } },
        { $limit: 5000 }
      ];
      const data = await GoodsReceipt.aggregate(pipeline);
      return res.json({ success: true, data });
    }
    const movementTypes = type === 'wastage' ? ['wastage', 'expiry']
      : type === 'department-consumption' ? ['issue', 'department_issue', 'recipe_consumption']
        : null;
    if (movementTypes) {
      const filter = {
        ...scope,
        movementType: { $in: movementTypes },
        ...(createdAt ? { createdAt } : {}),
        ...(department ? { department } : {}),
        ...(itemId ? { itemId } : {})
      };
      const data = await StockMovement.find(filter).populate('itemId', 'name code unit').populate('recordedBy', 'name')
        .sort({ createdAt: -1 }).limit(5000).lean();
      return res.json({ success: true, data });
    }
    if (type === 'ledger' || type === 'transfers' || type === 'adjustments') {
      const types = type === 'transfers' ? ['transfer']
        : type === 'adjustments' ? ['adjustment', 'physical_count']
          : null;
      const filter = {
        ...scope,
        ...(types ? { movementType: { $in: types } } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(department ? { department } : {}),
        ...(itemId ? { itemId } : {})
      };
      const data = await StockMovement.find(filter).populate('itemId', 'name code unit')
        .populate('recordedBy', 'name').sort({ createdAt: -1 }).limit(5000).lean();
      return res.json({ success: true, data });
    }
    res.status(400).json({ success: false, message: 'Unsupported inventory report type.' });
  } catch (err) {
    next(err);
  }
};

export const exportInventoryReport = async (req, res, next) => {
  try {
    const { type = 'stock', ...filters } = req.query;
    const request = { ...req, query: { ...filters, type } };
    const result = await new Promise((resolve, reject) => {
      getInventoryReport(request, {
        json: (body) => resolve(body),
        status: (status) => ({ json: (body) => resolve({ ...body, status }) })
      }, reject);
    });
    if (result.status && result.status !== 200) {
      return res.status(result.status).json(result);
    }
    const rows = result.data || [];
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row).filter((key) => key !== '__v')))];
    const csvValue = (value) => {
      const text = value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
      return `"${text.replace(/"/g, '""')}"`;
    };
    const csv = [columns.map(csvValue).join(','), ...rows.map((row) => columns.map((key) => csvValue(row[key])).join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inventory-${type}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
};
