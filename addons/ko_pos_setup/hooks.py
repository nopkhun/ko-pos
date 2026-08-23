# -*- coding: utf-8 -*-
import logging

_logger = logging.getLogger(__name__)

# ⚠️ ค่าเริ่มต้น — เปลี่ยนเป็นเบอร์พร้อมเพย์/เลขภาษีจริงของร้านใน Settings > Banks
PROMPTPAY_PLACEHOLDER_MOBILE = '0812345678'


def post_init_hook(env):
    env['ko.company.setup'].setup_company_info()
    company = env.ref('base.main_company', raise_if_not_found=False)
    if not company:
        company = env['res.company'].search([], limit=1, order='id')

    # 1) ราคาสินค้า = รวม VAT แล้ว (ปกติของร้านอาหารไทย)
    company.account_price_include = 'tax_included'

    # 2) บัญชีพร้อมเพย์ของบริษัท (สำหรับ EMV QR)
    partner_bank = env['res.partner.bank'].search([
        ('partner_id', '=', company.partner_id.id),
        ('proxy_type', 'in', ['mobile', 'merchant_tax_id', 'ewallet_id']),
    ], limit=1)
    if not partner_bank:
        partner_bank = env['res.partner.bank'].create({
            'acc_number': 'PROMPTPAY-KO',
            'partner_id': company.partner_id.id,
            'company_id': company.id,
            'proxy_type': 'mobile',
            'proxy_value': PROMPTPAY_PLACEHOLDER_MOBILE,
            'include_reference': False,
        })

    # 3) Journals
    AccountJournal = env['account.journal'].with_company(company)
    cash_journal = AccountJournal.search([
        ('type', '=', 'cash'), ('company_id', '=', company.id)], limit=1)
    if not cash_journal:
        cash_journal = AccountJournal.create({
            'name': 'เงินสด POS', 'type': 'cash', 'code': 'POSC',
            'company_id': company.id,
        })
    promptpay_journal = AccountJournal.search([
        ('type', '=', 'bank'), ('company_id', '=', company.id),
        ('bank_account_id', '=', partner_bank.id)], limit=1)
    if not promptpay_journal:
        promptpay_journal = AccountJournal.create({
            'name': 'พร้อมเพย์', 'type': 'bank', 'code': 'PPAY',
            'company_id': company.id,
            'bank_account_id': partner_bank.id,
        })

    # 4) Payment methods
    PayMethod = env['pos.payment.method'].with_company(company)
    pm_cash = PayMethod.search([('journal_id', '=', cash_journal.id)], limit=1)
    if not pm_cash:
        pm_cash = PayMethod.create({
            'name': 'เงินสด',
            'journal_id': cash_journal.id,
            'company_id': company.id,
        })
    pm_qr = PayMethod.search([('journal_id', '=', promptpay_journal.id)], limit=1)
    if not pm_qr:
        qr_vals = {
            'name': 'พร้อมเพย์ (สแกน QR)',
            'journal_id': promptpay_journal.id,
            'company_id': company.id,
            'payment_method_type': 'qr_code',
        }
        available_qr = [m[0] for m in env['res.partner.bank'].get_available_qr_methods_in_sequence()]
        if 'emv_qr' in available_qr:
            qr_vals['qr_code_method'] = 'emv_qr'
        try:
            pm_qr = PayMethod.create(qr_vals)
        except Exception as e:  # QR method may fail validation with placeholder data
            _logger.warning("Could not create PromptPay QR payment method: %s", e)
            pm_qr = PayMethod.create({
                'name': 'พร้อมเพย์ (โอน)',
                'journal_id': promptpay_journal.id,
                'company_id': company.id,
            })

    # 5) POS config ร้านอาหาร
    config = env['pos.config'].search([('company_id', '=', company.id)], limit=1)
    printer = env.ref('ko_pos_setup.kitchen_printer', raise_if_not_found=False)
    floors = env['restaurant.floor'].search([])
    config_vals = {
        'name': 'KO Restaurant',
        'module_pos_restaurant': True,
        'company_id': company.id,
        'payment_method_ids': [(6, 0, [pm_cash.id, pm_qr.id])],
        'floor_ids': [(6, 0, floors.ids)],
        'receipt_footer': 'ขอบคุณที่ใช้บริการ / Thank you',
    }
    if printer:
        config_vals.update({
            'is_order_printer': True,
            'printer_ids': [(6, 0, printer.ids)],
        })
    if config:
        config.write(config_vals)
    else:
        config = env['pos.config'].create(config_vals)

    _logger.info("KO POS setup done: config=%s, payment methods=%s",
                 config.name, [pm_cash.name, pm_qr.name])
