/* ---- band ---- */
inner_d = 18.5;
thick   = 2;
width   = 5;
round   = 0.8;

// battery model dropped in as a clearance solid
batt_l = 20.0;   // tangential
batt_w = 12.5;   // along finger axis
batt_t = 5.4;    // radial

// battery model dropped in as a clearance solid
ISP_l = 8.5;   // tangential
ISP_w = 8.5;   // along finger axis
ISP_t = 1.5;    // radial

/* ---- block ---- */
blk_l   = 22;    // tangential
blk_w   = 14.5;    // along finger axis
blk_h   = 8;     // radial height above the bore
wall    = 0.5;
floor_t = 0.5;   // floor between bore and battery

chip_l  = 18.5; chip_w = 10.5;                 // PCB pocket (open at top)

r_in = inner_d/2;

module band() {
    rotate_extrude($fn=180)
        translate([r_in, -width/2])
            offset(r=round) offset(r=-round)
                square([thick, width]);
}

// rounded box spanning radius r0..r1
module rbox(r0, r1, l, w, rad=1.5) {
    translate([r0, 0, 0]) rotate([0, 90, 0])
        linear_extrude(r1 - r0)
            offset(r=rad) offset(r=-rad) square([w, l], center=true);
}



// battery
module batt_model() {
    translate([r_in + floor_t, -batt_l/2, -batt_w/2])
        cube([batt_t, batt_l, batt_w]);
}

module ring_body (){
        union() {
        band();
        %rbox(r_in, r_in + blk_h, blk_l, blk_w); //case
    }
    //rbox(r_in+floor_t+batt_t-0.01, r_in+blk_h+1, chip_l, chip_w, 1);    // chip
    }


module ISP1507_model(){
        translate([r_in + floor_t+batt_t+0.5, -ISP_l/2, -ISP_w/2])
        cube([ISP_t, ISP_l, ISP_w]);
}

//difference() {
ring_body();
batt_model();    
ISP1507_model();    
//}