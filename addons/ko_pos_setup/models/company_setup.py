# -*- coding: utf-8 -*-
import logging
from odoo import api, models

_logger = logging.getLogger(__name__)


class KoCompanySetup(models.AbstractModel):
    _name = 'ko.company.setup'
    _description = 'KO Restaurant Company Setup'

    @api.model
    def setup_company_info(self):
        company = self.env.ref('base.main_company', raise_if_not_found=False)
        if not company:
            company = self.env['res.company'].search([], limit=1, order='id')
        if not company:
            _logger.warning("KO POS: No company found to update")
            return

        th_country = self.env.ref('base.th', raise_if_not_found=False)
        if not th_country:
            th_country = self.env['res.country'].search([('code', '=', 'TH')], limit=1)

        bkk_state = False
        if th_country:
            bkk_state = self.env['res.country.state'].search([
                ('country_id', '=', th_country.id),
                '|', ('code', '=', 'TH-10'), ('name', 'ilike', 'กรุงเทพ')
            ], limit=1)

        company_vals = {
            'name': 'บริษัท น็อกเอาต์ จำกัด',
            'street': '2/67 ซอย ประเสริฐมนูกิจ 29 แยก 4 ถนนประเสริฐมนูกิจ แขวงลาดพร้าว เขตลาดพร้าว',
            'street2': False,
            'city': 'กรุงเทพมหานคร',
            'zip': '10230',
            'vat': '0105564168851',
        }
        if th_country:
            company_vals['country_id'] = th_country.id
        if bkk_state:
            company_vals['state_id'] = bkk_state.id

        company.write(company_vals)
        if company.partner_id:
            company.partner_id.write(company_vals)
        _logger.info("KO POS: Company info updated successfully: %s, VAT: %s", company.name, company.vat)
