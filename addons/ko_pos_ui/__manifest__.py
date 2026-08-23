{
    "name": "KO POS Restaurant UI",
    "summary": "Touch-first restaurant POS interface for Thai staff",
    "version": "19.0.2.0.4",
    "category": "Point of Sale",
    "author": "KO POS",
    "license": "LGPL-3",
    "depends": ["point_of_sale", "pos_restaurant"],
    "assets": {
        "point_of_sale.assets_prod": [
            "ko_pos_ui/static/src/app/**/*",
        ],
    },
    "installable": True,
    "application": False,
}
