// Demo merchant for the agent-ready checkout (UCP / ACP): "Coffee Club Supply".
// Prices are integer minor units (cents), USD only. The catalog is the merchant's own price list:
// a buyer agent can only reference item ids; it never sends prices.

export const MERCHANT = {
  name: "Coffee Club Supply",
  currency: "USD",
  /** Hosted-demo cap on one checkout total (cents), same spirit as the remote MCP's 500.00 cap. */
  maxTotal: 50000,
} as const;

export interface Product {
  id: string;
  title: string;
  price: number;
  description: string;
  image_url?: string;
  /** Units in stock. */
  stock: number;
}

export const PRODUCTS: Product[] = [
  { id: "bag_house_blend_12oz", title: "House Blend whole bean, 12 oz bag", price: 1400, description: "Medium roast, chocolate and caramel.", stock: 200 },
  { id: "bag_ethiopia_yirgacheffe_12oz", title: "Ethiopia Yirgacheffe whole bean, 12 oz bag", price: 1800, description: "Light roast, floral and citrus.", stock: 120 },
  { id: "bag_decaf_colombia_12oz", title: "Decaf Colombia ground, 12 oz bag", price: 1600, description: "Swiss Water decaf, medium roast.", stock: 80 },
  { id: "mug_ceramic_black", title: "Coffee Club ceramic mug, 12 oz", price: 1200, description: "Matte black stoneware.", stock: 60 },
  { id: "filters_v60_100", title: "V60 paper filters, pack of 100", price: 800, description: "Size 02, unbleached.", stock: 300 },
  // Sold out on purpose: lets agents (and the conformance checks) see an out_of_stock answer.
  { id: "bag_panama_geisha_4oz", title: "Panama Geisha whole bean, 4 oz (sold out)", price: 3800, description: "Seasonal lot.", stock: 0 },
];

export const productById = (id: string) => PRODUCTS.find((p) => p.id === id);

export interface ShippingOption {
  id: string;
  title: string;
  amount: number;
  /** Free when the discounted subtotal is at least this (cents). */
  freeOver?: number;
  description: string;
}

/** Domestic (US) options. Free standard shipping when the item subtotal is at least $50. */
export const SHIPPING_OPTIONS: ShippingOption[] = [
  { id: "std-ground", title: "Standard ground (5-7 business days)", amount: 599, freeOver: 5000, description: "Free on orders of $50 or more." },
  { id: "express-2day", title: "Express (2 business days)", amount: 1499, description: "Ships the next business day." },
];

/** Any destination outside the US. */
export const INTL_OPTIONS: ShippingOption[] = [{ id: "intl-express", title: "International express (5-10 business days)", amount: 2999, description: "Duties paid by the buyer." }];

export const optionsFor = (country: string | undefined) => (!country || country.toUpperCase() === "US" ? SHIPPING_OPTIONS : INTL_OPTIONS);

export interface DiscountCode {
  code: string;
  title: string;
  percent?: number;
  /** Fixed reduction in cents. */
  fixed?: number;
}

/** AGENT10 is the advertised one; BEANS20 and FIVEOFF exist so stacking and fixed-amount rules can be checked. */
export const DISCOUNTS: DiscountCode[] = [
  { code: "AGENT10", title: "10% off for agent checkouts", percent: 10 },
  { code: "BEANS20", title: "20% off beans (club members)", percent: 20 },
  { code: "FIVEOFF", title: "$5.00 off", fixed: 500 },
];

export const discountByCode = (code: string) => DISCOUNTS.find((d) => d.code.toUpperCase() === code.trim().toUpperCase());

/** Flat US sales tax for the demo (none): totals still carry a tax line of 0 so agents see it explicitly. */
export const TAX_RATE = 0;
