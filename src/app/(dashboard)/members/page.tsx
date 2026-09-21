'use client'

import styles from '@/components/workspace/workspace.module.css'
import { PageHeader } from '@/components/PageHeader'
import { MemberList } from '@/components/MemberList'

export default function MembersPage() {
  return (
    <div className={styles.shell}>
      <PageHeader title="成员与角色" description="管理组织成员、角色分配与访问权限。" />
      <MemberList />
    </div>
  )
}
