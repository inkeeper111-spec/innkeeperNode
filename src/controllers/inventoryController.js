import { InventoryItem, StockMovement, Vendor, PurchaseOrder } from '../models/index.js';
import { generateReference } from '../utils/reference.js';
import { logAudit } from '../services/auditService.js';
import { notifyHotelOperations, notifyRoles } from '../services/notificationService.js';

export const getInventoryItems = async (req, res, next) => {
  try {
    const { category, lowStock } = req.query;
    const filter = { hotelId: req.hotelId };

    if (category && category !== 'all') filter.category = category;
    if (lowStock === 'true') {
      filter.$expr = { $lte: ['$currentStock', '$minStockThreshold'] };
    }

    const items = await InventoryItem.find(filter)
      .populate('vendorId', 'name contactPerson phone')
      .sort({ name: 1 });

    res.json({ success: true, data: items });
  } catch (err) {
    next(err);
  }
};

export const createInventoryItem = async (req, res, next) => {
  try {
    const item = await InventoryItem.create({
      ...req.body,
      hotelId: req.hotelId,
      propertyId: req.propertyId
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
    const { itemId, movementType, quantity, notes, referenceNumber } = req.body;

    const item = await InventoryItem.findOne({ _id: itemId, hotelId: req.hotelId });
    if (!item) {
      return res.status(404).json({ success: false, message: 'Item not found.' });
    }

    const qty = Number(quantity);
    const previousStock = item.currentStock;
    let newStock = previousStock;

    if (movementType === 'receipt') {
      newStock += qty;
    } else if (movementType === 'issue' || movementType === 'wastage') {
      if (previousStock < qty) {
        return res.status(400).json({ success: false, message: `Insufficient stock. Current stock is ${previousStock} ${item.unit}.` });
      }
      newStock -= qty;
    } else if (movementType === 'adjustment') {
      newStock = qty; // direct adjustment
    }

    item.currentStock = newStock;
    await item.save();

    const movement = await StockMovement.create({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      itemId: item._id,
      movementType,
      quantity: qty,
      previousStock,
      newStock,
      unitCost: item.unitCost,
      totalValue: Math.round(qty * item.unitCost * 100) / 100,
      referenceNumber: referenceNumber || generateReference('MOV'),
      notes: notes || '',
      recordedBy: req.user._id
    });

    // Check low stock trigger
    if (newStock <= item.minStockThreshold) {
      await notifyRoles({
        hotelId: req.hotelId,
        roles: ['hotel_admin', 'restaurant_staff'],
        title: 'Low Stock Alert',
        message: `An inventory item is below its minimum stock threshold (${newStock} ${item.unit}).`,
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
    const vendors = await Vendor.find({ hotelId: req.hotelId }).sort({ name: 1 });
    res.json({ success: true, data: vendors });
  } catch (err) {
    next(err);
  }
};

export const createVendor = async (req, res, next) => {
  try {
    const vendor = await Vendor.create({
      ...req.body,
      hotelId: req.hotelId
    });
    res.status(201).json({ success: true, data: vendor });
  } catch (err) {
    next(err);
  }
};

export const getPurchaseOrders = async (req, res, next) => {
  try {
    const pos = await PurchaseOrder.find({ hotelId: req.hotelId })
      .populate('vendorId', 'name contactPerson email phone')
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: pos });
  } catch (err) {
    next(err);
  }
};

export const createPurchaseOrder = async (req, res, next) => {
  try {
    const { vendorId, items, expectedDeliveryDate, notes } = req.body;
    const totalAmount = items.reduce((sum, item) => sum + (item.quantity * item.unitCost), 0);

    const po = await PurchaseOrder.create({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      poNumber: generateReference('PO'),
      vendorId,
      items: items.map(i => ({
        ...i,
        totalAmount: i.quantity * i.unitCost
      })),
      totalAmount,
      status: 'ordered',
      expectedDeliveryDate,
      notes,
      createdBy: req.user._id
    });

    res.status(201).json({ success: true, message: 'Purchase order issued.', data: po });
  } catch (err) {
    next(err);
  }
};

export const receivePurchaseOrder = async (req, res, next) => {
  try {
    const po = await PurchaseOrder.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!po) {
      return res.status(404).json({ success: false, message: 'Purchase order not found.' });
    }

    if (po.status === 'received') {
      return res.status(400).json({ success: false, message: 'Purchase order is already received.' });
    }

    // Auto-update inventory stocks for received items
    for (const item of po.items) {
      if (item.itemId) {
        const invItem = await InventoryItem.findById(item.itemId);
        if (invItem) {
          const prev = invItem.currentStock;
          invItem.currentStock += item.quantity;
          await invItem.save();

          await StockMovement.create({
            hotelId: req.hotelId,
            propertyId: req.propertyId,
            itemId: invItem._id,
            movementType: 'receipt',
            quantity: item.quantity,
            previousStock: prev,
            newStock: invItem.currentStock,
            unitCost: item.unitCost,
            totalValue: item.totalAmount,
            referenceNumber: po.poNumber,
            notes: `Auto-received from PO ${po.poNumber}`,
            recordedBy: req.user._id
          });
        }
      }
    }

    po.status = 'received';
    po.receivedDate = new Date();
    await po.save();

    res.json({
      success: true,
      message: 'Goods received and inventory stocks updated.',
      data: po
    });
  } catch (err) {
    next(err);
  }
};
