{
    "name": "KO POS Restaurant UI",
    "summary": "Touch-first restaurant POS interface for Thai staff",
    "version": "19.0.6.3.0",
    "category": "Point of Sale",
    "author": "KO POS",
    "license": "LGPL-3",
    "depends": ["point_of_sale", "pos_restaurant", "ko_pos_kds"],
    "assets": {
        "point_of_sale.assets_prod": [
            "ko_pos_ui/static/src/app/**/*",
        ],
    },
    "installable": True,
    "application": False,
}
