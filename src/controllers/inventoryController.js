import { GoodsReceipt, InventoryBatch, InventoryItem, SupplierPayment, Vendor, PurchaseOrder } from '../models/index.js';
import { generateReference } from '../utils/reference.js';
import { logAudit } from '../services/auditService.js';
import { notifyHotelOperations, notifyRoles } from '../services/notificationService.js';
import { postStockMovement, runInventoryTransaction } from '../services/inventoryService.js';

const isAdministrator = (user) => ['hotel_admin', 'super_admin'].includes(user?.role);

export const getInventoryItems = async (req, res, next) => {
  try {
    const { category, lowStock, search, page = 1, limit = 100 } = req.query;
    const filter = { hotelId: req.hotelId, propertyId: req.propertyId };
    if (req.query.includeInactive === 'true' && !isAdministrator(req.user)) {
      return res.status(403).json({ success: false, message: 'Only hotel administrators can view inactive inventory items.' });
    }

    if (category && category !== 'all') filter.category = category;
    if (search) {
      const escapedSearch = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: escapedSearch, $options: 'i' } },
        { code: { $regex: escapedSearch, $options: 'i' } },
        { barcode: { $regex: escapedSearch, $options: 'i' } }
      ];
    }
    if (req.query.includeInactive !== 'true') filter.isActive = true;
    if (lowStock === 'true') {
      filter.$expr = { $lte: ['$currentStock', '$minStockThreshold'] };
    }

    const pageNumber = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(limit) || 100));
    const sortFields = new Set(['name', 'code', 'category', 'currentStock', 'unitCost', 'createdAt']);
    const sortField = sortFields.has(req.query.sort) ? req.query.sort : 'name';
    const sortDirection = req.query.direction === 'desc' ? -1 : 1;
    const [items, total] = await Promise.all([
      InventoryItem.find(filter)
      .populate('vendorId', 'name contactPerson phone')
      .sort({ [sortField]: sortDirection })
      .skip((pageNumber - 1) * pageSize)
      .limit(pageSize)
      .lean(),
      InventoryItem.countDocuments(filter)
    ]);
    const expiredBatches = await InventoryBatch.aggregate([
      { $match: { hotelId: req.hotelId, propertyId: req.propertyId, itemId: { $in: items.map((item) => item._id) }, expiryDate: { $lte: new Date() }, remainingQuantity: { $gt: 0 } } },
      { $group: { _id: '$itemId', quantity: { $sum: '$remainingQuantity' } } }
    ]);
    const expiredByItem = new Map(expiredBatches.map((batch) => [String(batch._id), batch.quantity]));
    const rows = items.map((item) => ({
      ...item,
      availableStock: Math.max(0, item.currentStock - (expiredByItem.get(String(item._id)) || 0))
    }));

    res.json({ success: true, data: rows, pagination: { page: pageNumber, limit: pageSize, total, pages: Math.ceil(total / pageSize) } });
  } catch (err) {
    next(err);
  }
};

export const updateInventoryItem = async (req, res, next) => {
  try {
    const allowedFields = [
      'name', 'code', 'category', 'description', 'unit', 'unitCost', 'sellingPrice',
      'minStockThreshold', 'maxStockLevel', 'reorderQuantity', 'vendorId', 'barcode',
      'trackExpiry', 'trackBatchNumber', 'unitConversions', 'isActive', 'location'
    ];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([field]) => allowedFields.includes(field))
    );
    if (!Object.keys(updates).length) {
      return res.status(400).json({ success: false, message: 'Provide at least one supported inventory item field to update.' });
    }
    if (updates.name !== undefined && !String(updates.name).trim()) {
      return res.status(400).json({ success: false, message: 'Item name cannot be empty.' });
    }
    if (updates.code !== undefined) updates.code = String(updates.code).trim().toUpperCase();
    const item = await InventoryItem.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId, propertyId: req.propertyId },
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!item) return res.status(404).json({ success: false, message: 'Inventory item not found.' });
    await logAudit({
      hotelId: req.hotelId,
      action: 'UPDATE_INVENTORY_ITEM',
      entity: 'InventoryItem',
      entityId: item._id,
      details: updates,
      req
    });
    res.json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
};

export const createInventoryItem = async (req, res, next) => {
  try {
    const {
      name, code, currentStock = 0, minStockThreshold = 0, unitCost = 0,
      openingBatchNumber = '', openingExpiryDate = null, ...details
    } = req.body;
    const openingStock = Number(currentStock);
    if (!name?.trim() || !code?.trim() || !Number.isFinite(openingStock) || openingStock < 0
      || !Number.isFinite(Number(minStockThreshold)) || Number(minStockThreshold) < 0
      || !Number.isFinite(Number(unitCost)) || Number(unitCost) < 0) {
      return res.status(400).json({ success: false, message: 'Name, item code, and valid non-negative stock, minimum level, and unit cost are required.' });
    }

    const item = await runInventoryTransaction(async (session) => {
      const [created] = await InventoryItem.create([{
        ...details,
        name: name.trim(),
        code: code.trim().toUpperCase(),
        currentStock: 0,
        minStockThreshold: Number(minStockThreshold),
        unitCost: Number(unitCost),
        hotelId: req.hotelId,
        propertyId: req.propertyId
      }], { session });
      if (openingStock > 0) {
        await postStockMovement({
          hotelId: req.hotelId,
          propertyId: req.propertyId,
          itemId: created._id,
          movementType: 'opening',
          quantity: openingStock,
          location: details.location || 'Main Store',
          batchNumber: openingBatchNumber,
          expiryDate: openingExpiryDate ? new Date(openingExpiryDate) : null,
          referenceNumber: generateReference('OPEN'),
          notes: 'Opening inventory balance',
          recordedBy: req.user._id,
          idempotencyKey: `opening:${created._id}`,
          session
        });
      }
      return InventoryItem.findById(created._id).session(session);
    });
    await notifyHotelOperations({
      hotelId: req.hotelId,
      title: 'Inventory item added',
      message: 'A new inventory item was added.',
      module: 'inventory',
      eventType: 'inventory_item_created',
      relatedRecordId: item._id,
      link: '/inventory',
      eventId: `inventory-item-created:${item._id}`
    });

    res.status(201).json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
};

/**
 * Record Stock Movement (Audit Ledger)
 */
export const recordStockMovement = async (req, res, next) => {
  try {
    const { itemId, movementType, quantity, notes, referenceNumber, location, department, idempotencyKey } = req.body;
    if (!['receipt', 'issue', 'adjustment', 'wastage', 'return'].includes(movementType)) {
      return res.status(400).json({ success: false, message: 'Unsupported stock movement type.' });
    }
    if (movementType === 'adjustment' && !isAdministrator(req.user)) {
      return res.status(403).json({ success: false, message: 'Only hotel administrators can post direct stock adjustments.' });
    }
    if (!isAdministrator(req.user) && movementType !== 'issue') {
      return res.status(403).json({ success: false, message: 'Use an approved goods receipt or submit a stock adjustment request for this movement.' });
    }
    if (movementType === 'issue' && !department?.trim()) {
      return res.status(400).json({ success: false, message: 'Department is required for stock issues.' });
    }

    const result = await runInventoryTransaction((session) => postStockMovement({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      itemId,
      movementType,
      quantity,
      notes: notes || '',
      referenceNumber: referenceNumber || generateReference('MOV'),
      location: location || 'Main Store',
      department: department || '',
      batchNumber: req.body.batchNumber || '',
      expiryDate: req.body.expiryDate ? new Date(req.body.expiryDate) : null,
      recordedBy: req.user._id,
      idempotencyKey: idempotencyKey || req.get('Idempotency-Key'),
      session
    }));
    if (result.duplicate) {
      return res.json({ success: true, message: 'Stock movement was already recorded.', data: { movement: result.movement } });
    }
    const { movement, item } = result;

    // Check low stock trigger
    if (item.currentStock <= item.minStockThreshold) {
      await notifyRoles({
        hotelId: req.hotelId,
        roles: ['hotel_admin', 'restaurant_staff'],
        title: 'Low Stock Alert',
        message: `An inventory item is below its minimum stock threshold (${item.currentStock} ${item.unit}).`,
        module: 'inventory',
        eventType: 'inventory_low_stock',
        relatedRecordId: item._id,
        priority: 'high',
        link: '/inventory',
        eventId: `low-stock:${movement._id}`
      });
    }

    res.status(201).json({
      success: true,
      message: 'Stock movement recorded successfully.',
      data: { movement, item }
    });
  } catch (err) {
    next(err);
  }
};

export const getVendors = async (req, res, next) => {
  try {
    const vendors = await Vendor.find({ hotelId: req.hotelId }).populate('suppliedItems', 'name code unit').sort({ name: 1 });
    res.json({ success: true, data: vendors });
  } catch (err) {
    next(err);
  }
};

export const createVendor = async (req, res, next) => {
  try {
    const {
      name, contactPerson = '', email = '', phone, address = '',
      taxNumber = req.body.gstNumber || '', paymentTerms = 'Net 30', suppliedItems = []
    } = req.body;
    if (!name?.trim() || !phone?.trim()) {
      return res.status(400).json({ success: false, message: 'Supplier name and phone number are required.' });
    }
    if (!Array.isArray(suppliedItems)) {
      return res.status(400).json({ success: false, message: 'Supplied items must be a list.' });
    }
    if (suppliedItems.length) {
      const count = await InventoryItem.countDocuments({
        _id: { $in: suppliedItems }, hotelId: req.hotelId, propertyId: req.propertyId
      });
      if (count !== new Set(suppliedItems.map(String)).size) {
        return res.status(400).json({ success: false, message: 'Supplier contains an item from another property or an invalid item.' });
      }
    }
    const vendor = await Vendor.create({
      name: name.trim(),
      contactPerson,
      email,
      phone,
      address,
      taxNumber,
      paymentTerms,
      suppliedItems,
      hotelId: req.hotelId
    });
    res.status(201).json({ success: true, data: vendor });
  } catch (err) {
    next(err);
  }
};

export const updateVendor = async (req, res, next) => {
  try {
    const allowedFields = [
      'name', 'contactPerson', 'email', 'phone', 'address', 'taxNumber',
      'paymentTerms', 'status', 'suppliedItems'
    ];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([field]) => allowedFields.includes(field))
    );
    if (req.body.gstNumber !== undefined && updates.taxNumber === undefined) {
      updates.taxNumber = req.body.gstNumber;
    }
    if (updates.suppliedItems) {
      if (!Array.isArray(updates.suppliedItems)) {
        return res.status(400).json({ success: false, message: 'Supplied items must be a list.' });
      }
      const count = await InventoryItem.countDocuments({
        _id: { $in: updates.suppliedItems }, hotelId: req.hotelId, propertyId: req.propertyId
      });
      if (count !== new Set(updates.suppliedItems.map(String)).size) {
        return res.status(400).json({ success: false, message: 'Supplier contains an item from another property or an invalid item.' });
      }
    }
    const vendor = await Vendor.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      { $set: updates },
      { new: true, runValidators: true }
    ).populate('suppliedItems', 'name code unit');
    if (!vendor) return res.status(404).json({ success: false, message: 'Supplier not found.' });
    res.json({ success: true, data: vendor });
  } catch (err) {
    next(err);
  }
};

export const getVendorPurchases = async (req, res, next) => {
  try {
    const vendorExists = await Vendor.exists({ _id: req.params.id, hotelId: req.hotelId });
    if (!vendorExists) return res.status(404).json({ success: false, message: 'Supplier not found.' });
    const data = await PurchaseOrder.find({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      vendorId: req.params.id
    }).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getVendorPayments = async (req, res, next) => {
  try {
    const vendorExists = await Vendor.exists({ _id: req.params.id, hotelId: req.hotelId });
    if (!vendorExists) return res.status(404).json({ success: false, message: 'Supplier not found.' });
    const data = await SupplierPayment.find({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      vendorId: req.params.id
    }).populate('recordedBy', 'name').sort({ paidAt: -1 }).limit(200).lean();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const recordVendorPayment = async (req, res, next) => {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Supplier payment amount must be positive.' });
    }
    const key = req.body.idempotencyKey || req.get('Idempotency-Key');
    const payment = await runInventoryTransaction(async (session) => {
      if (key) {
        const duplicate = await SupplierPayment.findOne({
          hotelId: req.hotelId, propertyId: req.propertyId, idempotencyKey: key
        }).session(session);
        if (duplicate) return { payment: duplicate, duplicate: true };
      }
      const vendor = await Vendor.findOneAndUpdate({
        _id: req.params.id,
        hotelId: req.hotelId,
        $expr: { $gte: [{ $ifNull: ['$outstandingBalance', 0] }, amount] }
      }, { $inc: { outstandingBalance: -amount } }, { new: true, session });
      if (!vendor) {
        throw Object.assign(new Error('Supplier not found or payment exceeds the outstanding balance.'), { statusCode: 409 });
      }
      const [created] = await SupplierPayment.create([{
        hotelId: req.hotelId,
        propertyId: req.propertyId,
        vendorId: vendor._id,
        amount,
        paymentMethod: req.body.paymentMethod || 'bank_transfer',
        referenceNumber: req.body.referenceNumber || '',
        invoiceNumber: req.body.invoiceNumber || '',
        notes: req.body.notes || '',
        idempotencyKey: key || undefined,
        recordedBy: req.user._id
      }], { session });
      return { payment: created, duplicate: false };
    });
    if (!payment.duplicate) {
      await logAudit({
        hotelId: req.hotelId,
        action: 'RECORD_SUPPLIER_PAYMENT',
        entity: 'SupplierPayment',
        entityId: payment.payment._id,
        details: { vendorId: req.params.id, amount },
        req
      });
    }
    res.status(payment.duplicate ? 200 : 201).json({ success: true, data: payment });
  } catch (err) {
    next(err);
  }
};

export const getPurchaseOrders = async (req, res, next) => {
  try {
    const pos = await PurchaseOrder.find({ hotelId: req.hotelId, propertyId: req.propertyId })
      .populate('vendorId', 'name contactPerson email phone')
      .populate('createdBy', 'name')
      .populate('approvedBy', 'name')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: pos });
  } catch (err) {
    next(err);
  }
};

export const createPurchaseOrder = async (req, res, next) => {
  try {
    const { vendorId, items, expectedDeliveryDate, notes } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one purchase order item is required.' });
    }
    const vendor = await Vendor.findOne({ _id: vendorId, hotelId: req.hotelId, status: 'active' });
    if (!vendor) return res.status(400).json({ success: false, message: 'An active supplier is required.' });
    const purchaseLines = [];
    for (const line of items) {
      if (!Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0
        || !Number.isFinite(Number(line.unitCost)) || Number(line.unitCost) < 0) {
        return res.status(400).json({ success: false, message: 'Purchase quantities must be positive and unit prices cannot be negative.' });
      }
      const inventoryItem = await InventoryItem.findOne({
        _id: line.itemId, hotelId: req.hotelId, propertyId: req.propertyId, isActive: true
      }).select('name unit');
      if (!inventoryItem) return res.status(400).json({ success: false, message: 'Purchase order contains an invalid inventory item.' });
      purchaseLines.push({
        itemId: inventoryItem._id,
        itemName: inventoryItem.name,
        quantity: Number(line.quantity),
        unit: line.unit || inventoryItem.unit,
        unitCost: Number(line.unitCost),
        totalAmount: Number(line.quantity) * Number(line.unitCost)
      });
    }
    const subtotal = purchaseLines.reduce((sum, item) => sum + item.totalAmount, 0);
    const taxAmount = Number(req.body.taxAmount || 0);
    const discountAmount = Number(req.body.discountAmount || 0);
    if (!Number.isFinite(taxAmount) || taxAmount < 0 || !Number.isFinite(discountAmount) || discountAmount < 0 || discountAmount > subtotal) {
      return res.status(400).json({ success: false, message: 'Tax and discount must be valid; discount cannot exceed the subtotal.' });
    }
    const totalAmount = Math.round((subtotal + taxAmount - discountAmount) * 100) / 100;

    const po = await PurchaseOrder.create({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      poNumber: generateReference('PO'),
      vendorId,
      items: purchaseLines,
      subtotal,
      taxAmount,
      discountAmount,
      totalAmount,
      status: req.body.submitForApproval === true ? 'pending_approval' : 'ordered',
      expectedDeliveryDate,
      notes,
      createdBy: req.user._id
    });

    await logAudit({
      hotelId: req.hotelId,
      action: 'CREATE_INVENTORY_PURCHASE_ORDER',
      entity: 'PurchaseOrder',
      entityId: po._id,
      details: { poNumber: po.poNumber, totalAmount },
      req
    });
    res.status(201).json({ success: true, message: 'Purchase order issued.', data: po });
  } catch (err) {
    next(err);
  }
};

export const receivePurchaseOrder = async (req, res, next) => {
  try {
    const po = await PurchaseOrder.findOne({ _id: req.params.id, hotelId: req.hotelId, propertyId: req.propertyId });
    if (!po) {
      return res.status(404).json({ success: false, message: 'Purchase order not found.' });
    }

    const key = req.body.idempotencyKey || req.get('Idempotency-Key');
    const receipt = await runInventoryTransaction(async (session) => {
      if (key) {
        const duplicate = await GoodsReceipt.findOne({
          hotelId: req.hotelId, propertyId: req.propertyId, requestKey: key
        }).session(session);
        if (duplicate) return { receipt: duplicate, duplicate: true, po };
      }

      const currentPO = await PurchaseOrder.findOne({
        _id: req.params.id, hotelId: req.hotelId, propertyId: req.propertyId
      }).session(session);
      if (!currentPO || ['cancelled', 'received'].includes(currentPO.status)) {
        throw Object.assign(new Error('Purchase order is not open for receiving.'), { statusCode: 409 });
      }
      const lines = [];
      for (const poLine of currentPO.items) {
        const input = (req.body.items || []).find((line) => String(line.itemId) === String(poLine.itemId));
        const remaining = Math.max(0, poLine.quantity - (poLine.receivedQuantity || 0));
        const receivedQuantity = input ? Number(input.receivedQuantity) : (req.body.items ? 0 : remaining);
        const acceptedQuantity = input ? Number(input.acceptedQuantity ?? receivedQuantity) : receivedQuantity;
        const damagedQuantity = input ? Number(input.damagedQuantity || 0) : 0;
        const rejectedQuantity = input ? Number(input.rejectedQuantity || 0) : 0;
        if (![receivedQuantity, acceptedQuantity, damagedQuantity, rejectedQuantity].every(Number.isFinite)
          || receivedQuantity < 0 || receivedQuantity > remaining
          || acceptedQuantity < 0 || damagedQuantity < 0 || rejectedQuantity < 0
          || acceptedQuantity + damagedQuantity + rejectedQuantity > receivedQuantity) {
          throw Object.assign(new Error(`Invalid received quantities for ${poLine.itemName}.`), { statusCode: 400 });
        }
        if (receivedQuantity === 0) continue;
        const batchNumber = String(input?.batchNumber || '').trim();
        const expiryDate = input?.expiryDate ? new Date(input.expiryDate) : null;
        if (expiryDate && Number.isNaN(expiryDate.getTime())) {
          throw Object.assign(new Error(`Invalid expiry date for ${poLine.itemName}.`), { statusCode: 400 });
        }
        poLine.receivedQuantity = (poLine.receivedQuantity || 0) + receivedQuantity;
        lines.push({
          itemId: poLine.itemId,
          receivedQuantity,
          acceptedQuantity,
          damagedQuantity,
          rejectedQuantity,
          batchNumber,
          expiryDate,
          unitCost: poLine.unitCost
        });
        if (acceptedQuantity > 0) {
          await postStockMovement({
            hotelId: req.hotelId,
            propertyId: req.propertyId,
            itemId: poLine.itemId,
            movementType: 'receipt',
            quantity: acceptedQuantity,
            location: req.body.location || 'Main Store',
            referenceNumber: currentPO.poNumber,
            notes: `Goods receipt for purchase order ${currentPO.poNumber}`,
            recordedBy: req.user._id,
            idempotencyKey: `grn:${key || currentPO._id + ':' + currentPO.items.indexOf(poLine)}:${lines.length}`,
            batchNumber,
            expiryDate,
            session
          });
        }
      }
      if (!lines.length) throw Object.assign(new Error('Enter at least one received purchase order line.'), { statusCode: 400 });
      const [createdReceipt] = await GoodsReceipt.create([{
        hotelId: req.hotelId,
        propertyId: req.propertyId,
        purchaseOrderId: currentPO._id,
        receiptNumber: generateReference('GRN'),
        requestKey: key || undefined,
        invoiceNumber: req.body.invoiceNumber || '',
        invoiceAttachment: req.body.invoiceAttachment || '',
        location: req.body.location || 'Main Store',
        lines,
        receivedBy: req.user._id,
        notes: req.body.notes || ''
      }], { session });
      const receivedSubtotal = lines.reduce(
        (sum, line) => sum + line.acceptedQuantity * line.unitCost,
        0
      );
      const purchaseSubtotal = currentPO.subtotal
        || currentPO.items.reduce((sum, line) => sum + line.totalAmount, 0);
      const taxAndDiscount = currentPO.taxAmount - currentPO.discountAmount;
      const payableAmount = purchaseSubtotal > 0
        ? receivedSubtotal + taxAndDiscount * (receivedSubtotal / purchaseSubtotal)
        : receivedSubtotal;
      if (payableAmount > 0) {
        await Vendor.updateOne(
          { _id: currentPO.vendorId, hotelId: req.hotelId },
          { $inc: { outstandingBalance: Math.round(payableAmount * 100) / 100 } },
          { session }
        );
      }
      currentPO.receivingHistory.push(createdReceipt._id);
      const fullyReceived = currentPO.items.every((line) => line.receivedQuantity >= line.quantity);
      currentPO.status = fullyReceived ? 'received' : 'partially_received';
      if (fullyReceived) currentPO.receivedDate = new Date();
      currentPO.invoiceAttachment = req.body.invoiceAttachment || currentPO.invoiceAttachment;
      await currentPO.save({ session });
      return { receipt: createdReceipt, duplicate: false, po: currentPO };
    });

    if (receipt.duplicate) {
      return res.json({ success: true, message: 'Goods receipt was already recorded.', data: receipt });
    }

    res.json({
      success: true,
      message: 'Goods receipt recorded; accepted quantities were added to stock.',
      data: receipt
    });
  } catch (err) {
    next(err);
  }
};

export const receivePurchaseOrderGoods = receivePurchaseOrder;
