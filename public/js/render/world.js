// Numbers that define the projection and the draw passes. SPEC section 12.
export const Z_LIFT = 0.8;        // screen rise per unit of world z
export const VIEW_AREA = 700000;  // world units on screen with a mouse
export const VIEW_AREA_TOUCH = 500000;
export const MAX_PIXELS_HIGH = 2.6e6;
export const MAX_PIXELS_LOW = 1.2e6;
export const HIGH_Z = 48;         // balls above this fly over the y-sorted pass
